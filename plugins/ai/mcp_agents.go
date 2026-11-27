package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/plugins/ai/acp"
	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/caps"
	"antennae.space/ide/pod/plugins"
)

// The MCP tools of a Supervisor on the sessions of the Agents tool: the providers, a ticket's
// development started on its prepared worktree, the thread, a prompt and a stop. They run the
// same path as the Kanban UI (developTicket), so one ticket has one active development, its
// session stays visible in the Agents tool, and its permission questions go to the Questions
// tool of the IDE. Only the Supervisor profile is granted these tools
// (pod/server/mcp_policy.go).

func (s *A) agentMCPTools() []plugins.MCPTool {
	session := plugins.Str("Session id from agent_list")
	return []plugins.MCPTool{
		{
			Name:        "agent_providers",
			Description: "Lists the CLI agent providers the IDE can run through ACP on this machine, and the models each one selects where a session of this project tells them. Only provider and model ids go to agent_start.",
			Run:         s.mcpProviders,
		},
		{
			Name:        "agent_start",
			Description: "Starts the development of a ticket by a CLI agent, in its worktree: the ticket's briefing is its first prompt, then your message. The ticket must have a worktree (start its development in the IDE first) and be the step to develop of its lineage; cwd must be that worktree. Answers the session id at once while the agent initializes; one development per ticket.",
			Props: map[string]any{
				"id":       map[string]any{"type": "integer", "description": "Ticket number"},
				"provider": plugins.Str("Provider id from agent_providers (claude, codex, opencode, pi)"),
				"model":    plugins.Str("Model id, optional: applied and confirmed before the first prompt"),
				"message":  plugins.Str("Your words to the developer, sent after the briefing (optional)"),
			},
			Required: []string{"id", "provider"},
			Run:      s.mcpAgentStart,
		},
		{
			Name:        "agent_list",
			Description: "Lists the agent sessions of the project of cwd: their state, provider, model, ticket, queued prompts and statistics. Bounded by limit.",
			Props: map[string]any{
				"ticket": map[string]any{"type": "integer", "description": "Only the sessions of this ticket"},
				"limit":  map[string]any{"type": "integer", "description": "Maximum sessions, default 20"},
			},
			Run: s.mcpAgentList,
		},
		{
			Name:        "agent_read",
			Description: "Reads the thread of an agent session of the project of cwd: its state and statistics, then its prompts, answers and the permissions it asked. Bounded by last.",
			Props: map[string]any{
				"session": session,
				"last":    map[string]any{"type": "integer", "description": "Only the last entries, this many (default 30)"},
				"tools":   map[string]any{"type": "boolean", "description": "Also the tool calls, the plan and the notices"},
			},
			Required: []string{"session"},
			Run:      s.mcpAgentRead,
		},
		{
			Name:        "agent_send",
			Description: "Sends a prompt to an agent session of the project of cwd. Queued while a turn runs, sent at its next step. Read the answer later with agent_read.",
			Props:       map[string]any{"session": session, "message": plugins.Str("Your message, in Markdown")},
			Required:    []string{"session", "message"},
			Run:         s.mcpAgentSend,
		},
		{
			Name:        "agent_stop",
			Description: "Stops an agent session of the project of cwd: the turn running is cancelled and the prompts waiting dropped, so nothing resumes. The session and its thread stay visible in the IDE.",
			Props:       map[string]any{"session": session},
			Required:    []string{"session"},
			Run:         s.mcpAgentStop,
		},
	}
}

// agentsHere is the manager of the sessions of the project the client works in (an SSH project
// has none, an MCP grant outside the family is refused by the server).
func (s *A) agentsHere(sc plugins.MCPScope) (*acp.Manager, error) {
	rt, err := s.pod.Runtime(sc.Here.ID)
	if err != nil {
		return nil, err
	}
	m := s.agentsOf(rt)
	if m == nil {
		return nil, i18n.New("agents run on local projects only")
	}
	return m, nil
}

func (s *A) mcpProviders(_ context.Context, sc plugins.MCPScope, _ json.RawMessage) (string, error) {
	m, err := s.agentsHere(sc)
	seen := map[string][]string{}
	if err == nil {
		for _, info := range m.List() {
			if v := info.Model(); v != "" && !slices.Contains(seen[info.Agent], v) {
				seen[info.Agent] = append(seen[info.Agent], v)
			}
		}
	}
	var b strings.Builder
	b.WriteString("Providers the IDE runs through ACP, and the models a session of this project tells:\n")
	for _, a := range (acp.Catalog{Dir: s.Store.Path("acp")}).List() {
		install := "installed"
		if !a.Installed {
			install = "not installed"
			if a.Hint != "" {
				install += " (" + a.Hint + ")"
			}
		}
		if a.Missing != "" {
			install += ", needs " + a.Missing
		}
		line := fmt.Sprintf("- %s (%s): %s", a.ID, a.Name, install)
		if models := seen[a.ID]; len(models) > 0 {
			line += ", models: " + strings.Join(models, " | ")
		} else {
			line += ", models announced when a session opens"
		}
		b.WriteString(line + "\n")
	}
	return strings.TrimSuffix(b.String(), "\n"), nil
}

func (s *A) mcpAgentStart(ctx context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
	a, err := bind[struct {
		ID       int64
		Provider string
		Model    string
		Message  string
	}](raw)
	if err != nil {
		return "", err
	}
	if a.ID <= 0 {
		return "", i18n.New("id is missing: the ticket to develop")
	}
	if strings.TrimSpace(a.Provider) == "" {
		return "", i18n.New("provider is missing: pick one in agent_providers")
	}
	t, err := s.kanbanGet(ctx, sc.Root.ID, a.ID)
	if err != nil {
		return "", err
	}
	// The worktree is the one of the ticket, else of the root of its lineage.
	owner, root := t.ID, t
	if t.Parent != 0 {
		owner = t.Parent
		if root, err = s.kanbanGet(ctx, sc.Root.ID, t.Parent); err != nil {
			return "", err
		}
	}
	if root.Worktree == "" {
		return "", i18n.New("the ticket has no worktree: start its development in the IDE first")
	}
	child, tk := s.Projects.ChildAt(sc.Root.ID, root.Worktree)
	switch {
	case child == "":
		return "", i18n.Errorf("the worktree of ticket #%d is not registered in the IDE: open the worktree first", root.ID)
	case tk != owner, filepath.Clean(sc.Here.Path) != filepath.Clean(root.Worktree):
		return "", i18n.Errorf("cwd must be the worktree of ticket #%d (%s)", root.ID, root.Worktree)
	}
	if sc.AllowsProject != nil && !sc.AllowsProject(child, sc.Root.ID) {
		return "", i18n.New("the worktree is outside the MCP grant")
	}
	// The ticket must be the step to develop of its lineage.
	var step struct {
		ID int64 `json:"id"`
	}
	if err := s.kanbanCall(ctx, sc.Root.ID, "kanban.worktreeTicket", map[string]any{"ticket": a.ID}, &step); err != nil {
		return "", err
	}
	if step.ID != a.ID {
		return "", i18n.Errorf("ticket #%d is not the step to develop of its lineage: the active step is #%d", a.ID, step.ID)
	}
	// The provider must be installed; the model is applied by the session before its first
	// prompt, and the session carries its error.
	if _, err := (acp.Catalog{Dir: s.Store.Path("acp")}).Command(a.Provider); err != nil {
		return "", err
	}
	var md struct {
		Markdown string `json:"markdown"`
	}
	if err := s.kanbanCall(ctx, sc.Root.ID, "kanban.markdown", map[string]any{"id": a.ID}, &md); err != nil {
		return "", err
	}
	sess, created, err := s.developTicket(child, a.Provider, caps.TicketBrief{
		ID: t.ID, Parent: t.Parent, Role: "dev", Title: t.Title, Branch: t.Branch,
		Markdown: md.Markdown, Text: a.Message, Model: a.Model})
	if err != nil {
		return "", err
	}
	line := fmt.Sprintf("Session %s of ticket #%d in %s: %s, %s.", sess.ID, t.ID, root.Worktree, sess.Name, sess.State)
	if a.Model != "" {
		line += " Model " + a.Model + ", applied before the first prompt."
	}
	if created {
		line += " Its first prompt is the ticket briefing."
	} else {
		line += " Its prompt is sent now."
	}
	return line + " The session is visible in the Agents tool of the IDE, and its permission questions in the Questions tool: read them and its thread with agent_read.", nil
}

func (s *A) mcpAgentList(_ context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
	a, err := bind[struct {
		Ticket int64
		Limit  int
	}](raw)
	if err != nil {
		return "", err
	}
	if a.Limit <= 0 {
		a.Limit = 20
	}
	m, err := s.agentsHere(sc)
	if err != nil {
		return "", err
	}
	var out []string
	left := 0
	for _, info := range m.List() {
		if a.Ticket != 0 && info.Ticket != a.Ticket {
			continue
		}
		if len(out) >= a.Limit {
			left++
			continue
		}
		out = append(out, "- "+sessionLine(info))
	}
	if len(out) == 0 {
		return "No agent session in this project.", nil
	}
	text := fmt.Sprintf("Agent sessions of this project (%d):\n%s", len(out), strings.Join(out, "\n"))
	if left > 0 {
		text += fmt.Sprintf("\n(%d more sessions left out)", left)
	}
	return text, nil
}

func (s *A) mcpAgentRead(_ context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
	a, err := bind[struct {
		Session string
		Last    int
		Tools   bool
	}](raw)
	if err != nil {
		return "", err
	}
	m, err := s.agentsHere(sc)
	if err != nil {
		return "", err
	}
	sess, err := m.Get(a.Session)
	if err != nil {
		return "", err
	}
	info, entries := sess.Thread()
	last := a.Last
	if last <= 0 {
		last = 30
	}
	return sessionHead(info) + acpThreadText(info, entries, last, a.Tools, 1000), nil
}

func (s *A) mcpAgentSend(_ context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
	a, err := bind[struct{ Session, Message string }](raw)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(a.Message) == "" {
		return "", i18n.New("message is empty")
	}
	m, err := s.agentsHere(sc)
	if err != nil {
		return "", err
	}
	sess, err := m.Get(a.Session)
	if err != nil {
		return "", err
	}
	// The state before the prompt: a session that is running queues the message, a ready one
	// sends it now.
	state := sess.Info().State
	if err := sess.Prompt(a.Message); err != nil {
		return "", err
	}
	switch state {
	case acp.Starting, acp.Busy, acp.Asking:
		return "The session is running: your message is queued and sent at its next step. Read it later with agent_read.", nil
	}
	return "Message sent: the agent answers now. Read its answer later with agent_read.", nil
}

func (s *A) mcpAgentStop(_ context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
	a, err := bind[struct{ Session string }](raw)
	if err != nil {
		return "", err
	}
	m, err := s.agentsHere(sc)
	if err != nil {
		return "", err
	}
	sess, err := m.Get(a.Session)
	if err != nil {
		return "", err
	}
	if err := sess.Stop(); err != nil {
		return "", err
	}
	return fmt.Sprintf("Session %s stopped: its turn is cancelled and its queued prompts dropped, so nothing resumes. It stays visible in the Agents tool of the IDE with its thread; read it with agent_read.", a.Session), nil
}

// sessionLine is one agent session as agent_list gives it.
func sessionLine(info acp.Info) string {
	line := fmt.Sprintf("id %s | %s | %s | %s", info.ID, assistant.Cut(info.Title, 60), info.Name, info.State)
	if m := info.Model(); m != "" {
		line += " | model " + m
	}
	if info.Ticket != 0 {
		line += fmt.Sprintf(" | ticket #%d", info.Ticket)
	}
	if n := len(info.Queue); n > 0 {
		line += fmt.Sprintf(" | queued %d", n)
	}
	if st := info.Stats; st != nil {
		line += fmt.Sprintf(" | %d turns, work %s, cost $%.2f", st.Turns, fmtMs(st.Work), st.Cost)
	}
	if info.Error != "" {
		line += " | error: " + assistant.Cut(info.Error, 160)
	}
	return line
}

// sessionHead is what a bounded read says of a session before its thread.
func sessionHead(info acp.Info) string {
	line := fmt.Sprintf("Session %s (%s, %s)", info.ID, info.Name, info.State)
	if m := info.Model(); m != "" {
		line += ", model " + m
	}
	if info.Ticket != 0 {
		line += fmt.Sprintf(", ticket #%d", info.Ticket)
	}
	if n := len(info.Queue); n > 0 {
		line += fmt.Sprintf(", %d prompt(s) queued", n)
	}
	if st := info.Stats; st != nil {
		line += fmt.Sprintf(", %d turns, work %s, cost $%.2f, %d tokens", st.Turns, fmtMs(st.Work), st.Cost, st.Tokens)
	}
	if info.Error != "" {
		line += "\nError: " + assistant.Cut(info.Error, 200)
	}
	return line + "\n\n"
}

// fmtMs is a duration of milliseconds, short.
func fmtMs(ms int64) string {
	d := time.Duration(ms) * time.Millisecond
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%.0fs", d.Seconds())
	default:
		return fmt.Sprintf("%.0fmin", d.Minutes())
	}
}
