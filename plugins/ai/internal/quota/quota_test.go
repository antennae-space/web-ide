package quota

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDayLeft(t *testing.T) {
	reset := time.Date(2026, 11, 5, 1, 0, 0, 0, time.UTC)
	start := reset.Add(-week)
	cases := []struct {
		name string
		util float64
		now  time.Time
		want float64
	}{
		{"start of the window, nothing used", 0, start, 100},
		{"start of day 4, on the pace", 300.0 / 7, start.Add(3 * day), 100},
		{"end of day 4, its share used", 400.0 / 7, start.Add(4*day - time.Minute), 0},
		{"ahead of the pace", 500.0 / 7, start.Add(3*day + time.Hour), -100},
		{"half a share left", 50.0 / 7, start.Add(time.Hour), 50},
		{"last day", 90, start.Add(6*day + time.Hour), 70},
	}
	for _, c := range cases {
		got, _ := DayLeft(c.util, reset, c.now)
		if got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	if _, end := DayLeft(0, reset, start.Add(3*day+time.Hour)); !end.Equal(start.Add(4 * day)) {
		t.Errorf("end of the share: %v", end)
	}
}

func TestBudget(t *testing.T) {
	midnight := time.Date(2026, 11, 1, 0, 0, 0, 0, time.Local)
	if Budget(0, 3, midnight) != nil {
		t.Error("no budget, no quota")
	}
	if q := Budget(10, 3, midnight); q.Day != 70 || q.Source != "budget" || q.DayEnd != midnight.AddDate(0, 0, 1).UnixMilli() {
		t.Errorf("budget: %+v", q)
	}
	if q := Budget(10, 15, midnight); q.Day != -50 {
		t.Errorf("over the budget: %v", q.Day)
	}
}

func fake(t *testing.T, status int, body string) (*OAuth, *int) {
	t.Helper()
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer tok" || r.Header.Get("anthropic-beta") != "oauth-2025-04-20" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".claude"), 0o700)
	os.WriteFile(filepath.Join(home, ".claude", ".credentials.json"), []byte(`{"claudeAiOauth":{"accessToken":"tok","subscriptionType":"max"}}`), 0o600)
	o := NewOAuth(home)
	o.URL = srv.URL
	return o, &calls
}

const usage = `{"five_hour":{"utilization":30,"resets_at":"2026-11-01T15:00:00.125459+00:00"},
	"seven_day":{"utilization":36,"resets_at":"2026-11-05T01:00:00.125479+00:00"},"seven_day_opus":null,"other":{"x":1}}`

func TestOAuth(t *testing.T) {
	o, calls := fake(t, 200, usage)
	now := time.Date(2026, 11, 1, 11, 0, 0, 0, time.UTC)
	o.Now = func() time.Time { return now }
	q := o.Get(context.Background())
	if q == nil || q.Source != "oauth" || q.FiveHour.Utilization != 30 || q.Week.Utilization != 36 || q.Opus != nil || q.Plan != "max" || q.At != now.UnixMilli() {
		t.Fatalf("quota: %+v", q)
	}
	// Day 4 of the window: 4/7 allowed, 36 % used.
	if q.Day != 148 {
		t.Errorf("day: %v", q.Day)
	}
	o.Get(context.Background())
	if *calls != 1 {
		t.Errorf("read again within the TTL: %d calls", *calls)
	}
	o.Refresh()
	o.Get(context.Background())
	if *calls != 1 {
		t.Errorf("read again within the gap: %d calls", *calls)
	}
	now = now.Add(time.Minute)
	o.Get(context.Background())
	if *calls != 2 {
		t.Errorf("stale after the gap, not read: %d calls", *calls)
	}
	now = now.Add(3 * time.Minute)
	o.Get(context.Background())
	if *calls != 3 {
		t.Errorf("after the TTL, not read: %d calls", *calls)
	}
}

func TestOAuthFailures(t *testing.T) {
	for _, c := range []struct {
		name, body string
		status     int
	}{
		{"401", `{}`, 401},
		{"not JSON", `<html>`, 200},
		{"no 7-day window", `{"five_hour":{"utilization":3,"resets_at":"2026-11-01T15:00:00Z"}}`, 200},
		{"utilization missing", `{"seven_day":{"resets_at":"2026-11-05T01:00:00Z"}}`, 200},
		{"bad date", `{"seven_day":{"utilization":3,"resets_at":"soon"}}`, 200},
	} {
		o, _ := fake(t, c.status, c.body)
		if q := o.Get(context.Background()); q != nil {
			t.Errorf("%s: %+v", c.name, q)
		}
	}
	o := NewOAuth(t.TempDir())
	o.URL = "http://127.0.0.1:1"
	if o.Get(context.Background()) != nil {
		t.Error("no token, a quota")
	}
}
