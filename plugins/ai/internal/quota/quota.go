// Package quota is the daily quota of the Claude subscription: the share of the day of the
// 7-day window Anthropic counts, and the 5-hour one, read from its OAuth usage endpoint with
// the token of Claude Code; without that token, a budget in dollars a day set by the user,
// spent by the agents and the assistant since midnight.
package quota

import (
	"math"
	"time"
)

const (
	week = 7 * 24 * time.Hour
	day  = 24 * time.Hour
)

// Quota is what the bars show: the rest of the day in percent of its share (100 at its start,
// negative when the use runs ahead of the pace), and the windows of the subscription.
type Quota struct {
	// Source: "oauth" (the subscription), "budget" (the manual budget); Plan: the subscription
	// (pro, max) as Claude Code tells it; At: when it was read (Unix ms).
	Source string `json:"source"`
	Plan   string `json:"plan,omitempty"`
	At     int64  `json:"at"`
	// Day: the rest of the share of the day, in percent; DayEnd: when the next share starts
	// (Unix ms).
	Day    float64 `json:"day"`
	DayEnd int64   `json:"dayEnd"`
	// The windows of the subscription (oauth only); Utilization is their use in percent.
	FiveHour *Window `json:"fiveHour,omitempty"`
	Week     *Window `json:"week,omitempty"`
	Opus     *Window `json:"opus,omitempty"`
	// Budget and Spent of the manual source, in dollars.
	Budget float64 `json:"budget,omitempty"`
	Spent  float64 `json:"spent,omitempty"`
}

// Window is a window of the subscription: its use in percent and its reset (Unix ms).
type Window struct {
	Utilization float64 `json:"utilization"`
	ResetsAt    int64   `json:"resetsAt"`
}

// DayLeft is the rest of the share of the day of a 7-day window resetting at reset, used at
// util percent, at now: the window started 7 days before its reset, each day adds a seventh of
// it; what is left of the shares up to the end of today, in percent of one share. Also the
// end of today's share.
func DayLeft(util float64, reset, now time.Time) (float64, time.Time) {
	start := reset.Add(-week)
	n := math.Floor(float64(now.Sub(start)) / float64(day))
	n = max(0, min(6, n))
	share := 100.0 / 7
	left := (n+1)*share - util
	return round(left / share * 100), start.Add(time.Duration(n+1) * day)
}

// Budget is the quota of the manual source: budget dollars a day, spent since dayStart.
func Budget(budget, spent float64, dayStart time.Time) *Quota {
	if budget <= 0 {
		return nil
	}
	return &Quota{Source: "budget", At: time.Now().UnixMilli(), Day: round(100 * (1 - spent/budget)), DayEnd: dayStart.AddDate(0, 0, 1).UnixMilli(), Budget: budget, Spent: spent}
}

func round(x float64) float64 { return math.Round(x*10) / 10 }
