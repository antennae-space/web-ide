package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/plugins/ai/acp"
	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/plugins/ai/llm"
	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/plugins"
)

// Tools of the MCP endpoint on the conversations linked to a ticket (Host.MCPTool): Claude
// Code starts the development of a ticket (kanban_develop), reads a conversation
// (kanban_conversation), or takes part in it: it writes a message (kanban_reply) or answers
// the questions waiting for the user (kanban_answer). Its messages
// carry the author "claude" and the conversation goes on as if the user had sent them. They
// need the tickets of the Kanban, whose scope and ticket binding they share.

func (s *A) registerMCP() {
	for _, t := range append(append(s.mcpTools(), s.agentMCPTools()...), s.assistantMCPTools()...) {
		s.host.MCPTool(t)
	}
	for _, t := range s.delegationMCPTools() {
		s.host.MCPTool(t)
	}
}

func (s *A) mcpTools() []plugins.MCPTool {
	return []plugins.MCPTool{
		{
			Name:        "kanban_develop",
			Needs:       "tickets",
			Description: "Starts a Build conversation linked to a To do or In progress ticket in its worktree. Call kanban_start first if the ticket has no worktree. Returns the conversation id for kanban_conversation, kanban_reply and kanban_answer.",
			Props: map[string]any{"id": ticketID,
				"server": plugins.Str("Model server id (default: the one of the assistant settings)"),
				"model":  plugins.Str("Model (default: the one of the assistant settings)")},
			Run: ticketTool(s, func(ctx context.Context, sc plugins.MCPScope, id int64, a struct{ Server, Model string }) (string, error) {
				dc, err := s.developChat(ctx, sc, id, a.Server, a.Model)
				if err != nil {
					return "", err
				}
				if dc.Delegation != nil {
					if err := s.startMCPDelegation(sc, dc, 0); err != nil {
						return "", err
					}
					return delegationText(dc, "running"), nil
				}
				if err := s.startRun(chatLocOf(sc.Root), sc.Root.ID, dc.Ticket.Project, sc.Lang, dc, 0); err != nil {
					return "", err
				}
				return fmt.Sprintf("Development of ticket #%d started: conversation %s.\n"+
					"Read it with kanban_conversation, guide it with kanban_reply, and answer its questions with kanban_answer.", id, dc.ID), nil
			}),
		},
		{
			Name:        "kanban_conversation",
			Needs:       "tickets",
			Description: "Reads a conversation of the assistant linked to the ticket (see Linked conversations in kanban_get), or the session of the agent developing it (Agent session in kanban_get): the messages of the user and of the assistant, with the questions asked and their answers. Use it to take over a briefing; with last and tools, to review a development (its commands, errors and notes).",
			Props: map[string]any{"id": ticketID, "chat": plugins.Str("Conversation id (chat … in kanban_get)"),
				"last":  map[string]any{"type": "integer", "description": "Only the last messages, this many (default: all)"},
				"tools": map[string]any{"type": "boolean", "description": "Also the tool calls (name and arguments, cut), their errors, the answers that failed and the notes and reports of sub-agents"}},
			Required: []string{"chat"},
			Run: ticketTool(s, func(ctx context.Context, sc plugins.MCPScope, id int64, a struct {
				Chat  string
				Last  int
				Tools bool
			}) (string, error) {
				if sc.ACPParent != "" {
					c, err := s.loadMCPChat(sc, a.Chat)
					if err != nil || c.Ticket == nil || c.Ticket.ID != id {
						return "", errMCPConversation
					}
				}
				t, err := s.kanbanGet(ctx, sc.Root.ID, id)
				if err != nil {
					return "", err
				}
				linked := t.linked(a.Chat)
				if info, entries, ok := s.ticketSession(sc.Root.ID, t.ID, t.Parent); !linked && ok && info.ID == a.Chat {
					return acpThreadText(info, entries, a.Last, a.Tools, 0), nil
				}
				if !linked {
					return "", fmt.Errorf("conversation %s is not linked to ticket #%d", a.Chat, id)
				}
				if sc.AllowsProject != nil && !sc.AllowsProject(s.ticketChatProject(ctx, sc, t, a.Chat), sc.Root.ID) {
					return "", fmt.Errorf("conversation is outside the MCP grant")
				}
				raw, err := s.LLM.GetChat(chatLocOf(sc.Root), a.Chat)
				if err != nil {
					return "", err
				}
				text := conversationText(raw, a.Last, a.Tools)
				var chat engine.Chat
				_ = json.Unmarshal(raw, &chat)
				if !s.mcpChatAllowed(sc, &chat) {
					return "", errMCPConversation
				}
				if chat.Delegation != nil {
					return delegationCut(text + pendingQuestions(&chat, "The user can answer in the Questions tool of the IDE.")), nil
				}
				if s.Running(a.Chat) {
					return text + "\n\n(The assistant is answering now: read the conversation again later.)", nil
				}
				return text + pendingQuestions(&chat, "Answer with kanban_answer, one list of strings per question, in this order (an option label, several for a multiple choice, or a free text):"), nil
			}),
		},
		{
			Name:        "kanban_reply",
			Needs:       "tickets",
			Description: "Writes a message in a conversation of the assistant linked to the ticket, as Claude Code: the assistant reads it and answers (its questions still waiting are left aside; use kanban_answer to answer them). Queued if the conversation is running. Use it to answer a question the assistant asked in its text, or to guide it.",
			Props:       map[string]any{"id": ticketID, "chat": plugins.Str("Conversation id (chat … in kanban_get)"), "message": plugins.Str("Your message, in Markdown")},
			Required:    []string{"chat", "message"},
			Run: ticketTool(s, func(ctx context.Context, sc plugins.MCPScope, id int64, a struct{ Chat, Message string }) (string, error) {
				lc, err := s.linkedChat(ctx, sc, id, a.Chat)
				if err != nil {
					return "", err
				}
				return s.reply(sc, lc.loc, lc.root, lc.project, sc.Lang, a.Chat, a.Message, assistant.AuthorClaude)
			}),
		},
		{
			Name:        "kanban_answer",
			Needs:       "tickets",
			Description: "Answers the questions of ask_user waiting in a conversation of the assistant linked to the ticket, for the user (kanban_conversation lists them with their options); the assistant then goes on. Answer only what the plan, the ticket or the user already decided; otherwise leave the questions to the user.",
			Props: map[string]any{
				"id":   ticketID,
				"chat": plugins.Str("Conversation id (chat … in kanban_get)"),
				"answers": map[string]any{"type": "array", "description": "One list per question, in order: an option label, several for a multiple choice, the order for a rank, or a free text",
					"items": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}},
				"notes": plugins.StrList("A note per question (optional, same order)"),
			},
			Required: []string{"chat", "answers"},
			Run: ticketTool(s, func(ctx context.Context, sc plugins.MCPScope, id int64, a struct {
				Chat    string
				Answers [][]string
				Notes   []string
			}) (string, error) {
				lc, err := s.linkedChat(ctx, sc, id, a.Chat)
				if err != nil {
					return "", err
				}
				return s.answer(sc, lc.loc, lc.root, lc.project, sc.Lang, a.Chat, a.Answers, a.Notes)
			}),
		},
	}
}

// linkedChat is a conversation linked to a ticket, with where it runs.
type linkedChat struct {
	loc     llm.ChatLocation
	root    string
	project string
}

func (s *A) linkedChat(ctx context.Context, sc plugins.MCPScope, id int64, chatID string) (linkedChat, error) {
	if sc.ACPParent != "" {
		c, err := s.loadMCPChat(sc, chatID)
		if err != nil || c.Ticket == nil || c.Ticket.ID != id {
			return linkedChat{}, errMCPConversation
		}
	}
	t, err := s.kanbanGet(ctx, sc.Root.ID, id)
	if err != nil {
		return linkedChat{}, err
	}
	if !t.linked(chatID) {
		return linkedChat{}, fmt.Errorf("conversation %s is not linked to ticket #%d", chatID, id)
	}
	loc, root, err := s.ChatLoc(sc.Root.ID)
	if err != nil {
		return linkedChat{}, err
	}
	project := s.ticketChatProject(ctx, sc, t, chatID)
	if sc.AllowsProject != nil && !sc.AllowsProject(project, root) {
		return linkedChat{}, fmt.Errorf("conversation is outside the MCP grant")
	}
	return linkedChat{loc: loc, root: root, project: project}, nil
}

// ticketChatProject is where the tools of a linked conversation work: the worktree of the
// ticket (of the root of its lineage) for a development or a correction, else the project.
func (s *A) ticketChatProject(ctx context.Context, sc plugins.MCPScope, t *kbTicket, chatID string) string {
	role := ""
	for _, c := range t.ChatList {
		if c.ChatID == chatID {
			role = c.Role
		}
	}
	if role == "briefing" || role == "plan" {
		return sc.Root.ID
	}
	wt := t.Worktree
	if wt == "" && t.Parent != 0 {
		if p, err := s.kanbanGet(ctx, sc.Root.ID, t.Parent); err == nil {
			wt = p.Worktree
		}
	}
	if wt != "" {
		if child, _ := s.Projects.ChildAt(sc.Root.ID, wt); child != "" {
			return child
		}
	}
	return sc.Root.ID
}

func (s *A) developChat(ctx context.Context, sc plugins.MCPScope, id int64, server, model string) (*engine.Chat, error) {
	t, err := s.kanbanGet(ctx, sc.Root.ID, id)
	if err != nil {
		return nil, err
	}
	if t.Status != "todo" && t.Status != "in_progress" {
		return nil, i18n.Errorf("ticket #%d must be To do or In progress", id)
	}
	owner := t
	if t.Worktree == "" && t.Parent != 0 {
		owner, err = s.kanbanGet(ctx, sc.Root.ID, t.Parent)
		if err != nil {
			return nil, err
		}
	}
	if owner.Worktree == "" {
		return nil, i18n.Errorf("ticket #%d has no worktree: call kanban_start first", id)
	}
	project, ticket := s.Projects.ChildAt(sc.Root.ID, owner.Worktree)
	if project == "" || ticket != owner.ID {
		return nil, i18n.Errorf("the worktree of ticket #%d is not registered in the IDE: open the worktree first", owner.ID)
	}
	if sc.AllowsProject != nil && !sc.AllowsProject(project, sc.Root.ID) {
		return nil, i18n.New("the worktree is outside the MCP grant")
	}
	if sc.ACPParent != "" && project != sc.Here.ID {
		return nil, i18n.New("the worktree is outside the MCP grant")
	}
	for _, c := range t.ChatList {
		if s.Running(c.ChatID) {
			return nil, i18n.Errorf("conversation %s of ticket #%d is running", c.ChatID, id)
		}
	}
	if sc.ACPParent != "" {
		server, model, err = s.delegationModel(ctx, server, model)
		if err != nil {
			return nil, err
		}
	}
	defServer, defModel := s.LLM.Default()
	if server == "" {
		server = defServer
	}
	if model == "" && server == defServer {
		model = defModel
	}
	if server == "" || model == "" {
		return nil, i18n.New("Choose a server and a model")
	}
	if s.LLM.ServerName(server) == "" {
		return nil, i18n.Errorf("unknown model server %q", server)
	}
	title := i18n.T(sc.Lang, "#%d Development · %s", id, t.Title)
	if r := []rune(title); len(r) > 80 {
		title = string(r[:80])
	}
	text := i18n.T(sc.Lang, "Develop ticket #%d “%s” following its plan.", id, t.Title)
	effort := "auto"
	switch t.Complexity {
	case "high":
		effort = "xhigh"
	case "low":
		effort = "low"
	}
	chat := &engine.Chat{ID: assistant.NewID(), Title: title, Server: server, Model: model, Mode: engine.Build,
		MCPOwner: sc.Identity, MCPProject: project, MCPDevelopment: true,
		Ticket: &engine.TicketLink{ID: id, Role: "dev", Project: project, Effort: effort}}
	if sc.ACPParent != "" {
		chat.Delegation = &engine.Delegation{Parent: sc.ACPParent}
	}
	chat.AddUser(&engine.Message{Role: "user", Content: assistant.String(text), Display: text, Author: assistant.AuthorClaude})
	return chat, nil
}

// reply queues a message from an MCP client during a turn, or starts a new turn.
func (s *A) reply(sc plugins.MCPScope, loc llm.ChatLocation, root, project, lang, id, text, author string) (string, error) {
	if strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("message is empty")
	}
	if sc.ACPParent != "" && len(text) > delegationPromptBytes {
		return "", i18n.New("Assistant delegation input exceeds 16 KiB")
	}
	if r := s.run(id); r != nil {
		r.mu.Lock()
		if r.root != root || sc.AllowsProject != nil && !sc.AllowsProject(r.project, root) || !s.mcpChatAllowed(sc, r.chat) {
			r.mu.Unlock()
			return "", errMCPConversation
		}
		if !r.done {
			if r.chat.Parent != "" || r.chat.Agent != nil {
				r.mu.Unlock()
				return "", fmt.Errorf("MCP cannot steer a delegated conversation")
			}
			if r.chat.Delegation != nil {
				defer r.mu.Unlock()
				if r.ctx.Err() != nil {
					return "", errMCPConversation
				}
				size := len(text)
				for _, q := range r.chat.Queue {
					size += len(q.Text)
				}
				if size > delegationPromptBytes || len(r.chat.Queue) >= delegationModelSteps {
					return "", i18n.New("Assistant delegation input exceeds the queue limit")
				}
				r.chat.Queue = append(r.chat.Queue, engine.QueuedMessage{ID: assistant.NewID(), Text: text, Author: author})
				if err := s.publish(r, -1); err != nil {
					return "", err
				}
				return delegationText(r.chat, r.chat.Delegation.State), nil
			}
			r.chat.MCPProject = r.project
			r.chat.Queue = append(r.chat.Queue, engine.QueuedMessage{ID: assistant.NewID(), Text: text, Author: author})
			s.publish(r, -1)
			r.mu.Unlock()
			return "The conversation is running: your message is queued and sent at its next step.", nil
		}
		r.mu.Unlock()
	}
	chat, err := s.loadMCPChat(sc, id)
	if err != nil {
		return "", err
	}
	if chat.Parent != "" || chat.Agent != nil {
		return "", errMCPConversation
	}
	if chat.Server == "" || chat.Model == "" {
		return "", fmt.Errorf("this conversation has no model yet: the user must send its first message")
	}
	project = s.runProject(chat, root, project)
	chat.MCPProject = project
	if author == assistant.AuthorMCP {
		revive(chat)
	}
	from := minFrom(len(chat.Messages), skipQuestions(chat))
	chat.AddUser(&engine.Message{Role: "user", Content: assistant.String(text), Display: text, Author: author})
	if chat.Delegation != nil {
		if err := s.startMCPDelegation(sc, chat, from); err != nil {
			return "", err
		}
		return delegationText(chat, "running"), nil
	}
	if err := s.startRun(loc, root, project, lang, chat, from); err != nil {
		return "", err
	}
	reader := "kanban_conversation"
	if author == assistant.AuthorMCP {
		reader = "assistant_read"
	}
	return "Message sent: the assistant answers now. Read its answer later with " + reader + ".", nil
}

// answer answers the questions of ask_user waiting in a conversation (kanban_answer of the
// MCP), then starts it.
func (s *A) answer(sc plugins.MCPScope, loc llm.ChatLocation, root, project, lang, id string, answers [][]string, notes []string) (string, error) {
	chat, err := s.loadMCPChat(sc, id)
	if err != nil || chat.Parent != "" || chat.Agent != nil {
		return "", errMCPConversation
	}
	if s.run(id) != nil {
		return "", fmt.Errorf("the conversation is running: no question waits for an answer")
	}
	project = s.runProject(chat, root, project)
	chat.MCPProject = project
	index := -1
	for i, m := range chat.Messages {
		if m.AskState == "pending" {
			index = i
		}
	}
	if index < 0 {
		return "", fmt.Errorf("no question of this conversation waits for an answer")
	}
	m := chat.Messages[index]
	if len(answers) != len(m.Questions) {
		return "", fmt.Errorf("give one answer per question: %d questions, %d answers", len(m.Questions), len(answers))
	}
	// The questions of a graph are all answered: the path is the questions given an answer.
	var path []int
	if hasGraph(m.Questions) {
		for i, a := range answers {
			if len(a) > 0 {
				path = append(path, i)
			}
		}
	}
	m.Answers, m.Notes, m.Path, m.OffPath, m.AskState, m.Author = answers, notes, path, nil, "answered", assistant.AuthorClaude
	m.Content = assistant.String("Claude Code answered for the user.\n" + assistant.AnswersText(m.Questions, answers, notes, path, nil))
	m.Summary = assistant.T("answers received", nil).Raw()
	if chat.Delegation != nil {
		if len(m.Content) > delegationPromptBytes {
			return "", i18n.New("Assistant delegation input exceeds 16 KiB")
		}
		if err := s.startMCPDelegation(sc, chat, index); err != nil {
			return "", err
		}
		return delegationText(chat, "running"), nil
	}
	if err := s.startRun(loc, root, project, lang, chat, index); err != nil {
		return "", err
	}
	return "Answers sent: the assistant goes on.", nil
}

// pendingQuestions lists the questions waiting in a conversation.
func pendingQuestions(c *engine.Chat, instruction string) string {
	for i := len(c.Messages) - 1; i >= 0; i-- {
		m := c.Messages[i]
		if m.AskState != "pending" {
			continue
		}
		var b strings.Builder
		fmt.Fprintf(&b, "\n## Waiting for the answers of the user\n%s\n", instruction)
		for k, q := range m.Questions {
			fmt.Fprintf(&b, "%d. %s", k+1, q.Question)
			var labels []string
			for _, o := range q.Options {
				labels = append(labels, o.Label)
			}
			if len(labels) > 0 {
				fmt.Fprintf(&b, " [options: %s]", strings.Join(labels, " | "))
			}
			if q.Multiple {
				b.WriteString(" (multiple)")
			}
			b.WriteString("\n")
		}
		return b.String()
	}
	return ""
}

// conversationText is a conversation of the assistant as Claude reads it: what the user
// and the assistant wrote, and the questions of ask_user with their answers.
// conversationText is what Claude Code reads of a conversation: the last messages only when
// last > 0, and the tool calls, their errors and the failed answers with tools.
func conversationText(raw json.RawMessage, last int, tools bool) string {
	var chat struct {
		Title    string `json:"title"`
		Messages []struct {
			Role      string          `json:"role"`
			Content   json.RawMessage `json:"content"`
			Display   string          `json:"display"`
			Kind      string          `json:"kind"`
			Author    string          `json:"author"`
			ToolCalls []struct {
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
			ToolCallID string `json:"tool_call_id"`
			AskState   string `json:"askState"`
			Name       string `json:"name"`
			Status     string `json:"status"`
			Error      string `json:"error"`
		} `json:"messages"`
	}
	_ = json.Unmarshal(raw, &chat)
	text := func(c json.RawMessage) string {
		var s string
		if json.Unmarshal(c, &s) == nil {
			return s
		}
		var parts []struct{ Type, Text string }
		_ = json.Unmarshal(c, &parts)
		var out []string
		for _, p := range parts {
			if p.Type == "text" {
				out = append(out, p.Text)
			}
		}
		return strings.Join(out, "\n")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# Conversation: %s\n", chat.Title)
	asks := map[string]bool{}
	msgs := chat.Messages
	if last > 0 && last < len(msgs) {
		fmt.Fprintf(&b, "\n(%d earlier messages left out)\n", len(msgs)-last)
		msgs = msgs[len(msgs)-last:]
	}
	for _, m := range msgs {
		switch m.Role {
		case "user":
			t := m.Display
			if t == "" {
				t = text(m.Content)
			}
			label := "User"
			if m.Author == assistant.AuthorClaude {
				label = "Claude Code (you)"
			} else if m.Author == assistant.AuthorMCP {
				label = "MCP client"
			}
			if m.Kind == "summary" {
				label = "Summary of the earlier messages"
			}
			fmt.Fprintf(&b, "\n## %s\n%s\n", label, strings.TrimSpace(t))
		case "assistant":
			if t := strings.TrimSpace(text(m.Content)); t != "" {
				fmt.Fprintf(&b, "\n## Assistant\n%s\n", t)
			}
			for _, c := range m.ToolCalls {
				if c.Function.Name == "ask_user" {
					asks[c.ID] = true
					fmt.Fprintf(&b, "\n## Assistant asks (ask_user)\n%s\n", c.Function.Arguments)
				} else if tools {
					fmt.Fprintf(&b, "- call %s %s\n", c.Function.Name, assistant.Cut(c.Function.Arguments, 300))
				}
			}
			if tools && m.Error != "" {
				fmt.Fprintf(&b, "\n## The answer failed\n%s\n", m.Error)
			}
		case "tool":
			switch {
			case asks[m.ToolCallID] && m.AskState != "pending":
				fmt.Fprintf(&b, "\n## Answers of the user\n%s\n", strings.TrimSpace(text(m.Content)))
			case tools && (m.Name == "agent_note" || m.Name == "agent_report"):
				// The note itself is in the call; its result says nothing more.
			case tools && (m.Status == "error" || m.Status == "denied" || strings.HasPrefix(text(m.Content), "Interrupted")):
				fmt.Fprintf(&b, "  → %s: %s\n", m.Status, assistant.Cut(strings.TrimSpace(text(m.Content)), 300))
			}
		}
	}
	return strings.TrimSpace(b.String())
}

// acpThreadText is the thread of a session of the Agents tool as kanban_conversation gives
// it: the prompts and answers, the questions; with tools, the tool calls and the notices.
// cut bounds the text of each entry (0: no cut), last the entries kept.
func acpThreadText(info acp.Info, entries []acp.Entry, last int, tools bool, cut int) string {
	short := func(t string) string {
		if cut > 0 {
			return assistant.Cut(t, cut)
		}
		return t
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# Agent session: %s (%s, %s)\n", info.Title, info.Name, info.State)
	if last > 0 && last < len(entries) {
		fmt.Fprintf(&b, "\n(%d earlier entries left out)\n", len(entries)-last)
		entries = entries[len(entries)-last:]
	}
	for _, e := range entries {
		switch e.Kind {
		case "user":
			fmt.Fprintf(&b, "\n## User\n%s\n", strings.TrimSpace(short(e.Text)))
		case "agent":
			fmt.Fprintf(&b, "\n## %s\n%s\n", info.Name, strings.TrimSpace(short(e.Text)))
		case "permission":
			outcome := e.Outcome
			if outcome == "" {
				outcome = "waiting for the user"
			}
			fmt.Fprintf(&b, "\n## %s asks permission: %s (%s)\n", info.Name, e.Title, outcome)
		case "plan":
			if tools {
				b.WriteString("\n## Plan\n")
				for _, p := range e.Plan {
					fmt.Fprintf(&b, "- [%s] %s\n", p.Status, p.Content)
				}
			}
		case "tool":
			if tools {
				fmt.Fprintf(&b, "- %s %s (%s)\n", e.ToolKind, assistant.Cut(e.Title, 300), e.Status)
			}
		case "notice", "error":
			if tools {
				fmt.Fprintf(&b, "\n(%s)\n", e.Text)
			}
		}
	}
	return b.String()
}
