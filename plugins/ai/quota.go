package ai

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"time"

	"antennae.space/ide/plugins/ai/acp"
	"antennae.space/ide/plugins/ai/internal/quota"
)

// quotas: the daily quota of the bars of the Agents tool and the Assistant (internal/quota):
// the subscription of Claude Code, else the manual budget, whose spending is kept a moment.
type quotas struct {
	oauth *quota.OAuth
	mu    sync.Mutex
	since int64
	spent float64
	at    time.Time
}

// quotaHome is where Claude Code keeps its token: WEBIDE_INSTRUCTIONS_HOME replaces the home
// directory in the tests, as for the instructions.
func quotaHome() string {
	if h := os.Getenv("WEBIDE_INSTRUCTIONS_HOME"); h != "" {
		return h
	}
	h, _ := os.UserHomeDir()
	return h
}

// llm.quota: the quota of the day, or null without a source. budget: the dollars a day of the
// manual source (the setting of the plugin), since: the local midnight of the window (ms).
func (s *A) registerQuota() {
	s.quotas.oauth = quota.NewOAuth(quotaHome())
	s.handle("llm.quota", func(ctx context.Context, c *Client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			Budget float64 `json:"budget"`
			Since  int64   `json:"since"`
		}](p)
		if err != nil {
			return nil, err
		}
		if q := s.quotas.oauth.Get(ctx); q != nil {
			return q, nil
		}
		if a.Budget <= 0 {
			return nil, nil
		}
		return quota.Budget(a.Budget, s.spentSince(a.Since), time.UnixMilli(a.Since)), nil
	})
}

// quotaTurn: a turn of an agent or of the assistant ended; the windows ask the quota again.
func (s *A) quotaTurn() {
	if s.quotas.oauth == nil {
		return
	}
	s.quotas.oauth.Refresh()
	s.quotas.mu.Lock()
	s.quotas.at = time.Time{}
	s.quotas.mu.Unlock()
	s.pod.Broadcast("llm.quota", nil)
}

// spentSince is what the agents and the assistant spent since a time (ms), on every project:
// the cost of the turns of the agents and of the answers of the conversations, kept 30 s.
func (s *A) spentSince(since int64) float64 {
	s.quotas.mu.Lock()
	defer s.quotas.mu.Unlock()
	if s.quotas.since == since && time.Since(s.quotas.at) < 30*time.Second {
		return s.quotas.spent
	}
	all := func(string) bool { return true }
	spent := acp.Sum(s.Store.Path("agents"), all, time.UnixMilli(since)).Cost
	for _, p := range s.Projects.List() {
		loc, _, err := s.ChatLoc(p.ID)
		if err != nil || !s.LLM.HasChats(loc) {
			continue
		}
		list, err := s.LLM.ListChats(loc)
		if err != nil {
			continue
		}
		for _, info := range list {
			if info.Updated < since || info.Cost == 0 {
				continue
			}
			if c, err := s.loadChat(loc, info.ID); err == nil {
				spent += chatCostSince(c, since)
			}
		}
	}
	s.quotas.since, s.quotas.spent, s.quotas.at = since, spent, time.Now()
	return spent
}
