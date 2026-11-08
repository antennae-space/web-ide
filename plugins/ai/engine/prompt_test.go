package engine

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"antennae.space/ide/plugins/ai/llm"
	"antennae.space/ide/pod/assistant"
)

// The date and the active file are noted on a message of the user only when they changed
// since the last message still sent that carried them; a compaction makes them come again.
func TestStamp(t *testing.T) {
	now := time.Date(2026, 10, 31, 10, 0, 0, 0, time.Local)
	Now = func() time.Time { return now }
	defer func() { Now = time.Now }()
	c := &Chat{Options: &assistant.Options{ActiveFile: "a.go"}}
	add := func() *Message {
		m := &Message{Role: "user", Content: assistant.String("hi")}
		c.AddUser(m)
		c.Messages = append(c.Messages, &Message{Role: "assistant", Content: assistant.String("ok")})
		return m
	}
	if m := add(); m.Date != "Saturday, October 31, 2026" || m.ActiveFile != "a.go" {
		t.Fatalf("first message: %+v", m)
	}
	if m := add(); m.Date != "" || m.ActiveFile != "" {
		t.Fatalf("nothing changed: %+v", m)
	}
	c.Options.ActiveFile = "" // no file open: nothing to tell
	if m := add(); m.Date != "" || m.ActiveFile != "" {
		t.Fatalf("no active file: %+v", m)
	}
	c.Options.ActiveFile = "b.go"
	now = now.Add(24 * time.Hour)
	if m := add(); m.Date != "Sunday, November 1, 2026" || m.ActiveFile != "b.go" || Context(m) != "(Date: Sunday, November 1, 2026. Active file in the editor: b.go.)" {
		t.Fatalf("both changed: %+v %q", m, Context(m))
	}
	for _, m := range c.Messages {
		m.Compacted = true
	}
	if m := add(); m.Date == "" || m.ActiveFile != "b.go" {
		t.Fatalf("after a compaction: %+v", m)
	}
}

// With its tools the model reads the ticket with kanban_get: the system prompt has only the
// instructions of its role.
func TestTicketPrompt(t *testing.T) {
	p := TicketPrompt(7, "dev", "ticket/7-x", 0, 0, "")
	if !strings.Contains(p, "kanban_get (id 7)") || !strings.Contains(p, "ticket/7-x") {
		t.Fatal(p)
	}
	if p := TicketPrompt(7, "dev", "", 0, 0, "# The ticket"); !strings.HasSuffix(p, "# The ticket") || strings.Contains(p, "kanban_get (id") {
		t.Fatal(p)
	}
}

// The rules of every AI are in the system prompt once, whatever the mode, with or without
// tools, and a template of the user does not remove them.
func TestSystemPromptRules(t *testing.T) {
	custom := "My own template."
	for _, mode := range []string{Build, Plan, Briefing, Orchestrator} {
		for _, tools := range []bool{true, false} {
			for _, c := range []*llm.Context{nil, {GlobalPrompt: &custom, GlobalPlanPrompt: &custom, GlobalBriefingPrompt: &custom}} {
				p := SystemPrompt(c, PromptVars{Project: "p", Root: "/r"}, tools, mode, "")
				if strings.Count(p, assistant.AgentRules) != 1 {
					t.Fatalf("mode %s, tools %v: %d copies of the rules in %q", mode, tools, strings.Count(p, assistant.AgentRules), p)
				}
			}
		}
	}
	// With the custom template, the template stays and the rules follow it.
	p := SystemPrompt(&llm.Context{GlobalPrompt: &custom}, PromptVars{}, true, Build, "")
	if !strings.HasPrefix(p, custom+"\n\n"+assistant.AgentRules) {
		t.Fatal(p)
	}
}

// Each role of a ticket: the assistant gets the rules from its system prompt, not twice; an
// agent of the Agents tool gets them with the briefing of the role.
func TestRolePrompts(t *testing.T) {
	shared := map[string][]string{
		"briefing": {assistant.RoleDescription},
		"plan":     {assistant.RolePlanSave},
		"dev":      {assistant.RoleDevFollow, assistant.RoleNoMerge, assistant.RoleDevEnd, assistant.TestSummaryStyle},
		"correction": {
			assistant.RoleFixKinds, assistant.RoleNoMerge, assistant.RoleFixDone,
		},
		"resolve":       {},
		"consolidation": {assistant.ConsolidationRead, assistant.ConsolidationKeep, assistant.ConsolidationWhere, assistant.RoleNoMerge, assistant.ConsolidationNote, assistant.ConsolidationEnd},
	}
	if len(shared) != len(RoleInstructions) {
		t.Fatalf("a role has no test: %d roles", len(RoleInstructions))
	}
	for role, lines := range shared {
		if _, ok := RoleInstructions[role]; !ok {
			t.Fatalf("no role %s", role)
		}
		assist := TicketPrompt(7, role, "ticket/7-x", 0, 0, "")
		if strings.Contains(assist, assistant.AgentRules) {
			t.Fatalf("%s: the rules are already in the system prompt", role)
		}
		for _, l := range lines {
			if !strings.Contains(assist, l) {
				t.Fatalf("%s: missing %q in %q", role, l, assist)
			}
		}
		agent := AgentPrompt(7, role, "ticket/7-x", 0, 0, "# The ticket")
		if !strings.Contains(agent, "# The ticket") || strings.Count(agent, assistant.AgentRules) != 1 {
			t.Fatalf("%s: agent prompt %q", role, agent)
		}
		if strings.Contains(agent, "{{") {
			t.Fatalf("%s: placeholder left in %q", role, agent)
		}
	}
}

// The tools that write a test summary, a description or a report state their format.
func TestToolDescriptionsStyle(t *testing.T) {
	var all []assistant.Def
	all = append(append(append(all, kanbanReadDefs...), kanbanWriteDefs...), childAgentDefs...)
	prop := func(name, field string) string {
		for _, d := range all {
			if d.Name != name {
				continue
			}
			var def struct {
				Function struct {
					Parameters struct {
						Properties map[string]struct {
							Description string `json:"description"`
						} `json:"properties"`
					} `json:"parameters"`
				} `json:"function"`
			}
			if err := json.Unmarshal(d.JSON, &def); err != nil {
				t.Fatal(err)
			}
			return def.Function.Parameters.Properties[field].Description
		}
		t.Fatalf("no tool %s", name)
		return ""
	}
	for _, c := range []struct{ tool, field, want string }{
		{"kanban_create", "description", assistant.DescriptionStyle},
		{"kanban_update", "description", assistant.DescriptionStyle},
		{"kanban_update", "test_summary", assistant.TestSummaryStyle},
		{"kanban_move", "test_summary", assistant.TestSummaryStyle},
		{"agent_report", "summary", "in English"},
	} {
		if got := prop(c.tool, c.field); !strings.Contains(got, c.want) {
			t.Fatalf("%s.%s: %q has no %q", c.tool, c.field, got, c.want)
		}
	}
}
