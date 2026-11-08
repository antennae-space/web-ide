package server

import (
	"strings"
	"testing"

	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/config"
)

func promptText(t *testing.T, name string, args map[string]string) string {
	t.Helper()
	res, err := mcpPrompt(name, args)
	if err != nil {
		t.Fatal(err)
	}
	msg := res["messages"].([]any)[0].(map[string]any)
	return msg["content"].(map[string]any)["text"].(string)
}

// Each role carries the rules of every AI and the lines it shares with the assistant.
func TestMCPRolePrompts(t *testing.T) {
	shared := map[string][]string{
		"brief":       {assistant.RoleDescription},
		"plan":        {assistant.RolePlanSave},
		"dev":         {assistant.RoleDevFollow, assistant.RoleNoMerge, assistant.RoleDevEnd, assistant.TestSummaryStyle},
		"fix":         {assistant.RoleFixKinds, assistant.RoleNoMerge, assistant.RoleFixDone},
		"review":      {},
		"coverage":    {},
		"consolidate": {assistant.ConsolidationRead, assistant.ConsolidationKeep, assistant.ConsolidationWhere, assistant.ConsolidationCommit, assistant.RoleNoMerge, assistant.ConsolidationNote, assistant.ConsolidationEnd},
	}
	if len(shared) != len(mcpRoles) {
		t.Fatalf("a role has no test: %d roles", len(mcpRoles))
	}
	for role, lines := range shared {
		text := promptText(t, role, map[string]string{promptArg(role): "7"})
		if strings.Count(text, assistant.AgentRules) != 1 {
			t.Fatalf("%s: the rules are missing in %q", role, text)
		}
		for _, l := range lines {
			if !strings.Contains(text, strings.ReplaceAll(l, "{{id}}", "7")) {
				t.Fatalf("%s: missing %q in %q", role, l, text)
			}
		}
		if strings.Contains(text, "{{") {
			t.Fatalf("%s: placeholder left in %q", role, text)
		}
	}
}

// Claude Code cuts the instructions of a server at about 4 KB (measured on 2.1.318): what comes
// after the cut is lost, and the rules come last.
func TestMCPInstructionsSize(t *testing.T) {
	s := &Server{Cfg: &config.Config{PublicURL: "https://antennae.space/pod/hYeU_VKC3_2D9fXmnF6npwky9byVv4EVlwvnAbw_hIg", Addr: "127.0.0.1:4433"}}
	text := s.mcpInstructions()
	if !strings.HasSuffix(text, assistant.AgentRules) || !strings.Contains(text, "two addresses") {
		t.Fatal(text)
	}
	if len(text) > 3900 {
		t.Fatalf("instructions of %d bytes, 3900 at most", len(text))
	}
}
