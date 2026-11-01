package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// URL is the usage endpoint of Claude's OAuth (not documented: any error or unexpected shape
// gives no quota). WEBIDE_QUOTA_URL replaces it (tests).
const URL = "https://api.anthropic.com/api/oauth/usage"

// OAuth reads the windows of the subscription with the token Claude Code keeps, read only:
// the token goes to the endpoint only. One read is shared by every window of the pod for TTL;
// Refresh reads again sooner (the end of a turn), not more than once per Gap.
type OAuth struct {
	URL         string
	Credentials string
	Client      *http.Client
	TTL, Gap    time.Duration
	// Now is the clock (tests).
	Now func() time.Time

	mu      sync.Mutex
	last    *Quota
	at      time.Time
	stale   bool
	failure string // the last error logged, logged once
}

// NewOAuth reads the credentials of Claude Code in home.
func NewOAuth(home string) *OAuth {
	u := URL
	if v := os.Getenv("WEBIDE_QUOTA_URL"); v != "" {
		u = v
	}
	return &OAuth{URL: u, Credentials: filepath.Join(home, ".claude", ".credentials.json"),
		Client: &http.Client{Timeout: 10 * time.Second}, TTL: 2 * time.Minute, Gap: 30 * time.Second, Now: time.Now}
}

// Get is the quota of the subscription, read again when older than TTL (or stale since Gap);
// nil without a token or when the endpoint fails.
func (o *OAuth) Get(ctx context.Context) *Quota {
	tok, plan, err := o.token()
	if err != nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	now := o.Now()
	if !o.at.IsZero() && now.Sub(o.at) < o.TTL && (!o.stale || now.Sub(o.at) < o.Gap) {
		return o.last
	}
	q, err := o.fetch(ctx, tok, now)
	if q != nil {
		q.Plan = plan
	}
	o.at, o.stale = now, false
	if err != nil {
		if msg := err.Error(); msg != o.failure {
			log.Printf("quota: %s", msg)
			o.failure = msg
		}
		o.last = nil
		return nil
	}
	o.failure, o.last = "", q
	return q
}

// Refresh: a turn ended, the next Get reads the endpoint again (after Gap).
func (o *OAuth) Refresh() {
	o.mu.Lock()
	o.stale = true
	o.mu.Unlock()
}

// token is the access token of Claude Code and its plan (pro, max).
func (o *OAuth) token() (string, string, error) {
	data, err := os.ReadFile(o.Credentials)
	if err != nil {
		return "", "", errors.New("no Claude token")
	}
	var c struct {
		OAuth struct {
			AccessToken      string `json:"accessToken"`
			SubscriptionType string `json:"subscriptionType"`
		} `json:"claudeAiOauth"`
	}
	if json.Unmarshal(data, &c) != nil || c.OAuth.AccessToken == "" {
		return "", "", errors.New("no Claude token")
	}
	return c.OAuth.AccessToken, c.OAuth.SubscriptionType, nil
}

type window struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    string   `json:"resets_at"`
}

func (w *window) parse() (*Window, error) {
	if w == nil {
		return nil, nil
	}
	if w.Utilization == nil {
		return nil, errors.New("a window without utilization")
	}
	t, err := time.Parse(time.RFC3339Nano, w.ResetsAt)
	if err != nil {
		return nil, fmt.Errorf("resets_at: %w", err)
	}
	return &Window{Utilization: *w.Utilization, ResetsAt: t.UnixMilli()}, nil
}

func (o *OAuth) fetch(ctx context.Context, tok string, now time.Time) (*Quota, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, o.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	res, err := o.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("usage endpoint: %s", res.Status)
	}
	var body struct {
		FiveHour *window `json:"five_hour"`
		SevenDay *window `json:"seven_day"`
		Opus     *window `json:"seven_day_opus"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("usage endpoint: %w", err)
	}
	q := &Quota{Source: "oauth", At: now.UnixMilli()}
	if q.Week, err = body.SevenDay.parse(); err != nil || q.Week == nil {
		return nil, fmt.Errorf("usage endpoint: no 7-day window (%v)", err)
	}
	if q.FiveHour, err = body.FiveHour.parse(); err != nil {
		return nil, fmt.Errorf("usage endpoint: %w", err)
	}
	if q.Opus, err = body.Opus.parse(); err != nil {
		q.Opus = nil // optional
	}
	left, end := DayLeft(q.Week.Utilization, time.UnixMilli(q.Week.ResetsAt), now)
	q.Day, q.DayEnd = left, end.UnixMilli()
	return q, nil
}
