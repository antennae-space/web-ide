package ai

import (
	"fmt"
	"strings"
	"time"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/pod/assistant"
)

// Tools of the Orchestrator mode (assistant/orchestrator.go): what to do next, what was done,
// the conversations of the project, action cards the user clicks, and the conversation the
// user is moved into.

func (s *A) orchestratorTool(r *assistantRun, ref *runtimeRef, name string, a assistant.Args) (assistant.ToolResult, error) {
	switch name {
	case "kanban_next", "kanban_history":
		// The Kanban answers them (#158).
		return s.kanbanTool(r, name, a, engine.Orchestrator), nil
	case "list_conversations":
		return s.listConversations(r, a.Str("query"), a.Num("limit"))
	case "action_card":
		return s.actionCard(r, a)
	case "open_conversation":
		return s.openConversation(r, a)
	}
	return assistant.ToolResult{}, assistant.Usagef("unknown tool: %s", name)
}

func (s *A) listConversations(r *assistantRun, query string, limit int) (assistant.ToolResult, error) {
	list, err := s.LLM.ListChats(r.loc)
	if err != nil {
		return assistant.ToolResult{}, err
	}
	if limit <= 0 {
		limit = 20
	}
	q := strings.ToLower(strings.TrimSpace(query))
	var lines []string
	for _, c := range list {
		if c.ID == r.id || q != "" && !strings.Contains(strings.ToLower(c.Title), q) {
			continue
		}
		mode := c.Mode
		if mode == "" {
			mode = engine.Build
		}
		line := fmt.Sprintf("- %s %q · %s · %s", c.ID, c.Title, mode, time.UnixMilli(c.Updated).In(time.Local).Format("2006-01-02 15:04"))
		if c.Ticket != 0 {
			line += fmt.Sprintf(" · ticket #%d", c.Ticket)
		}
		if c.Parent != "" {
			line += fmt.Sprintf(" · sub-agent of %s (%s)", c.Parent, c.Status)
		}
		if state, _ := s.stateOf(c.ID); state != "idle" {
			line += " · " + state
		} else if c.Waiting {
			line += " · waiting for the user"
		} else if c.Failed {
			line += " · failed (agent_resume)"
		}
		lines = append(lines, line)
		if len(lines) == limit {
			break
		}
	}
	if len(lines) == 0 {
		return assistant.OK("No conversation.", assistant.Tn(0, "{n} conversation", "{n} conversations", nil)), nil
	}
	return assistant.OK(strings.Join(lines, "\n"), assistant.Tn(len(lines), "{n} conversation", "{n} conversations", nil)), nil
}

func (s *A) actionCard(r *assistantRun, a assistant.Args) (assistant.ToolResult, error) {
	card := &assistant.ActionCard{Kind: a.Str("kind"), Ticket: int64(a.Num("ticket")), Chat: a.Str("chat"), Label: strings.TrimSpace(a.Str("label")), Reason: strings.TrimSpace(a.Str("reason"))}
	known := false
	for _, k := range engine.ActionKinds {
		known = known || k == card.Kind
	}
	if !known {
		return assistant.ToolResult{}, assistant.Usagef("unknown kind %q (%s)", card.Kind, strings.Join(engine.ActionKinds, ", "))
	}
	if card.Label == "" {
		return assistant.ToolResult{}, assistant.Usagef("label is missing")
	}
	if card.Kind == "open_conversation" {
		if _, err := s.loadChat(r.loc, card.Chat); err != nil {
			return assistant.ToolResult{}, assistant.Usagef("unknown conversation %q (see list_conversations)", card.Chat)
		}
	} else if _, err := s.kanbanGet(r.ctx, r.root, card.Ticket); err != nil {
		return assistant.ToolResult{}, failf("ticket #%d not found", card.Ticket)
	}
	res := assistant.OKPlain("Card shown to the user; the action runs only if they click it.", card.Label)
	res.Card = card
	return res, nil
}

func (s *A) openConversation(r *assistantRun, a assistant.Args) (assistant.ToolResult, error) {
	var id, title string
	if id = strings.TrimSpace(a.Str("chat")); id != "" {
		c, err := s.loadChat(r.loc, id)
		if err != nil {
			return assistant.ToolResult{}, assistant.Usagef("unknown conversation %q (see list_conversations)", id)
		}
		title = c.Title
	} else {
		mode := a.Str("mode")
		switch mode {
		case "":
			mode = engine.Briefing
		case engine.Briefing, engine.Plan, engine.Build:
		default:
			return assistant.ToolResult{}, assistant.Usagef("mode must be briefing, plan or build")
		}
		r.mu.Lock()
		server, model := r.chat.Server, r.chat.Model
		var opts *assistant.Options
		if r.chat.Options != nil {
			o := *r.chat.Options
			opts = &o
		}
		r.mu.Unlock()
		c := &engine.Chat{ID: assistant.NewID(), Title: strings.TrimSpace(a.Str("title")), Server: server, Model: model, Mode: mode, Options: opts}
		if n := int64(a.Num("ticket")); n > 0 {
			if mode == engine.Build {
				return assistant.ToolResult{}, failf("to develop a ticket, propose action_card start_dev: it runs in the worktree of the ticket")
			}
			t, err := s.kanbanGet(r.ctx, r.root, n)
			if err != nil {
				return assistant.ToolResult{}, failf("ticket #%d not found", n)
			}
			c.Ticket = &engine.TicketLink{ID: n, Role: mode}
			if c.Title == "" {
				c.Title = fmt.Sprintf("#%d %s", n, t.Title)
			}
		}
		message := strings.TrimSpace(a.Str("message"))
		if a.Bool("send", false) && message != "" {
			c.Messages = []*engine.Message{{Role: "user", Content: assistant.String(message)}}
			s.startRun(r.loc, r.root, r.project, r.lang, c, 0)
		} else {
			c.Draft = message
			if c.Title == "" {
				c.Title = "Conversation"
			}
			if err := s.publishIdle(r.loc, r.root, c, 0); err != nil {
				return assistant.ToolResult{}, err
			}
		}
		id, title = c.ID, c.Title
	}
	// The windows showing this conversation move to the other one.
	s.emitAssistant(r.root, "assistant.open", map[string]string{"chat": id, "from": r.id})
	res := assistant.OK(fmt.Sprintf("Conversation %s %q opened for the user: they go on there. This conversation stays in their history.", id, title), assistant.T("opened: {title}", map[string]any{"title": title}))
	res.Opened = id
	return res, nil
}
