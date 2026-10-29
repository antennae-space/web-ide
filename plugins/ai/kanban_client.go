package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sync"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/plugins/ai/llm"
	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/projects"
)

// The Kanban as the AI reaches it (#158): through its methods (Pod.CallPlugin), built-in or
// external, never its Go types. The kanban tools of the assistant run in the Kanban
// (kanban.assistantTool) with the conversation; the AI reads a ticket (kanban.get, as
// kbTicket) and its Markdown (kanban.markdown).

// kbTicket is what the AI reads of a ticket.
type kbTicket struct {
	ID       int64  `json:"id"`
	Title    string `json:"title"`
	Parent   int64  `json:"parent"`
	Branch   string `json:"branch"`
	Worktree string `json:"worktree"`
	ChatList []struct {
		ChatID string `json:"chatId"`
		Role   string `json:"role"`
	} `json:"chatList"`
}

// linked tells whether a conversation is linked to the ticket.
func (t *kbTicket) linked(chat string) bool {
	for _, c := range t.ChatList {
		if c.ChatID == chat {
			return true
		}
	}
	return false
}

func (s *A) kanbanCall(ctx context.Context, project, method string, params, out any) error {
	raw, err := s.pod.CallPlugin(ctx, project, method, params)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// kanbanGet reads a ticket of the kanban of project (a main project or one of its worktrees).
func (s *A) kanbanGet(ctx context.Context, project string, id int64) (*kbTicket, error) {
	var t kbTicket
	if err := s.kanbanCall(ctx, project, "kanban.get", map[string]any{"id": id}, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// chatLocOf is where the conversations of a main project are kept: its .ide (a local project),
// else the pod's store.
func chatLocOf(p *projects.Project) llm.ChatLocation {
	l := llm.ChatLocation{Project: p.ID}
	if p.Type == "local" {
		l.IdeDir = filepath.Join(p.Path, ".ide")
	}
	return l
}

// kanbanTool runs a kanban tool of the assistant in the Kanban, with the conversation: its id,
// title and ticket, its mode, the pages of its board (attached to a ticket it creates or
// updates). A Briefing conversation becomes linked to the first ticket it creates.
func (s *A) kanbanTool(r *assistantRun, name string, a assistant.Args, mode string) assistant.ToolResult {
	tc := map[string]any{"mode": mode}
	r.mu.Lock()
	chat := map[string]any{"id": r.chat.ID, "title": r.chat.Title}
	if t := r.chat.Ticket; t != nil {
		chat["ticket"] = map[string]any{"id": t.ID, "role": t.Role}
	}
	tc["chat"] = chat
	if name == "kanban_create" || name == "kanban_update" {
		tc["doodles"] = boardDoodles(r.chat.Messages)
	}
	r.mu.Unlock()
	var out struct {
		Result assistant.ToolResult
		Linked int64
	}
	if err := s.kanbanCall(r.ctx, r.root, "kanban.assistantTool", map[string]any{"name": name, "args": a, "context": tc}, &out); err != nil {
		return fail(r, err)
	}
	if out.Linked != 0 {
		r.mu.Lock()
		if r.chat.Ticket == nil {
			r.chat.Ticket = &engine.TicketLink{ID: out.Linked, Role: "briefing"}
			s.publish(r, -1)
		}
		r.mu.Unlock()
	}
	return out.Result
}

// boardDoodles are the pages of the board of a conversation with a PNG, named as their files
// on a ticket: the doodles of the user ("Doodle 1.png", "Doodle 1 (2).png" for two messages)
// and the pages drawn by the model ("Page 2 Plan.png").
func boardDoodles(messages []*engine.Message) []map[string]string {
	seen := map[string]int{}
	var out []map[string]string
	for _, p := range engine.Pages(messages) {
		if p.PNG == "" {
			continue
		}
		name := p.Name
		if p.Kind == "model" {
			name = fmt.Sprintf("Page %d %s", p.Number, p.Name)
		} else if seen[p.Name]++; seen[p.Name] > 1 {
			name = fmt.Sprintf("%s (%d)", p.Name, seen[p.Name])
		}
		out = append(out, map[string]string{"name": name + ".png", "png": p.PNG})
	}
	return out
}

// linkedChats are the conversations told to the Kanban as linked to their ticket, with the
// title told: a conversation is saved often, the Kanban is told once (and of a new title).
var linkedChats sync.Map

// linkTicketChat tells the Kanban of root that a conversation is linked to its ticket.
func (s *A) linkTicketChat(root string, c *engine.Chat) {
	key := fmt.Sprintf("%s:%d:%s", root, c.Ticket.ID, c.ID)
	if was, ok := linkedChats.Load(key); ok && was == c.Ticket.Role+"|"+c.Title {
		return
	}
	if err := s.kanbanCall(context.Background(), root, "kanban.chat.link", map[string]any{"id": c.Ticket.ID, "chatId": c.ID, "role": c.Ticket.Role, "title": c.Title}, nil); err == nil {
		linkedChats.Store(key, c.Ticket.Role+"|"+c.Title)
	}
}

// ticketPrompt is the ticket part of the system prompt of a conversation linked to a ticket.
func (s *A) ticketPrompt(r *assistantRun, link *engine.TicketLink) string {
	var t struct {
		ID       int64  `json:"id"`
		Parent   int64  `json:"parent"`
		Branch   string `json:"branch"`
		Markdown string `json:"markdown"`
	}
	if err := s.kanbanCall(r.ctx, r.root, "kanban.markdown", map[string]any{"id": link.ID}, &t); err != nil {
		return fmt.Sprintf("# Linked ticket\nTicket #%d cannot be found (%s).", link.ID, err)
	}
	return engine.TicketPrompt(t.ID, link.Role, t.Branch, t.Parent, link.Feedback, t.Markdown)
}

// ticketTool makes an MCP tool on a ticket: its id (by default the ticket of the client's
// worktree, the active step of its lineage) and its arguments.
func ticketTool[T any](s *A, f func(ctx context.Context, sc plugins.MCPScope, id int64, a T) (string, error)) func(context.Context, plugins.MCPScope, json.RawMessage) (string, error) {
	return func(ctx context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
		var head struct {
			ID int64 `json:"id"`
		}
		var a T
		if err := json.Unmarshal(raw, &head); err != nil {
			return "", err
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return "", err
		}
		id := head.ID
		if id == 0 && sc.Ticket != 0 {
			var step struct {
				ID int64 `json:"id"`
			}
			id = sc.Ticket
			if s.kanbanCall(ctx, sc.Root.ID, "kanban.worktreeTicket", map[string]any{"ticket": sc.Ticket}, &step) == nil && step.ID != 0 {
				id = step.ID
			}
		}
		if id == 0 {
			return "", fmt.Errorf("id is missing: give the ticket number (outside the worktree of a ticket)")
		}
		return f(ctx, sc, id, a)
	}
}

// ticketID is the parameter of the ticket of a tool of the MCP.
var ticketID = map[string]any{"type": "integer", "description": "Ticket number (default: the ticket of the worktree you are in)"}
