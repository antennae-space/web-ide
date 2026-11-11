package llm

import (
	"strings"

	"antennae.space/ide/lib/i18n"
)

// Web is the provider of the web tools of the assistant (web_search, web_fetch): Brave Search
// with its key, or a SearXNG of the user. Search "" (none): the tools are not offered.
type Web struct {
	Search  string `json:"search,omitempty"` // brave | searxng
	SearXNG string `json:"searxng,omitempty"`
	// BraveKey: synced by the vault under BraveKeyName, never sent to the page.
	BraveKey string `json:"braveKey,omitempty"`
}

// BraveKeyName is the name of the key of Brave Search in the llm map of the vault (no server
// has this id: server ids have no colon).
const BraveKeyName = "web:brave"

// SetWeb sets the provider of the web tools. An empty key keeps the stored one.
func (m *Manager) SetWeb(search, searxng, braveKey string) error {
	switch search {
	case "", "none":
		search = ""
	case "brave", "searxng":
	default:
		return i18n.Errorf("unknown web search provider: %s", search)
	}
	if search == "searxng" && searxngURL(searxng) == "" {
		return i18n.New("the address of the SearXNG is missing")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cfg.Web.Search, m.cfg.Web.SearXNG = search, searxngURL(searxng)
	if braveKey != "" {
		m.cfg.Web.BraveKey = braveKey
	}
	return m.st.WriteJSON(configFile, m.cfg)
}

// WebConfig is the provider of the web tools (Search "": off).
func (m *Manager) WebConfig() Web {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cfg.Web
}

// searxngURL is the address of a SearXNG, with a scheme and without the last slash.
func searxngURL(u string) string {
	u = strings.TrimRight(strings.TrimSpace(u), "/")
	if u != "" && !strings.Contains(u, "://") {
		u = "http://" + u
	}
	return u
}
