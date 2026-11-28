package ai

import (
	"context"
	"encoding/json"
	"strings"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/plugins"
)

func (s *A) assistantMCPTools() []plugins.MCPTool {
	chat := plugins.Str("Conversation id from assistant_list or assistant_start")
	message := plugins.Str("Markdown message for the Assistant")
	return []plugins.MCPTool{
		{
			Name:        "assistant_list",
			Description: "Lists Assistant conversations in the project, including conversation ids, modes, tickets, sub-agents and current states. Supervisors can inspect ACP delegations in their grant.",
			Props: map[string]any{
				"query":  plugins.Str("Filter by title"),
				"limit":  map[string]any{"type": "integer", "description": "Maximum number of conversations, default 20"},
				"active": map[string]any{"type": "boolean", "description": "Only running conversations and those waiting for the user"},
			},
			Run: func(_ context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
				a, err := bind[struct {
					Query  string
					Limit  int
					Active bool
				}](raw)
				if err != nil {
					return "", err
				}
				loc := chatLocOf(sc.Root)
				lines, err := s.conversationLines(loc, "", a.Query, a.Limit, a.Active, func(id string) (string, bool) {
					c, err := s.loadChat(loc, id)
					if err != nil || !s.mcpChatInspectable(sc, c) {
						return "", false
					}
					return mcpInspectionDetails(sc, c), true
				})
				if sc.ACPParent != "" && (sc.RefreshACPGrant == nil || !sc.RefreshACPGrant()) {
					return "", errMCPConversation
				}
				if err == nil && len(lines) == 0 {
					return "No conversation.", nil
				}
				text := strings.Join(lines, "\n")
				if sc.ACPParent != "" {
					text = delegationCut(text)
				}
				return text, err
			},
		},
		{
			Name:        "assistant_read",
			Description: "Reads an Assistant conversation in the project, including questions waiting for the user. For Supervisor inspection of an ACP delegation, includes the parent session and current turn state.",
			Props: map[string]any{
				"chat":  chat,
				"last":  map[string]any{"type": "integer", "description": "Maximum number of recent messages, default all"},
				"tools": map[string]any{"type": "boolean", "description": "Include tool calls and errors"},
			},
			Required: []string{"chat"},
			Run: func(_ context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
				a, err := bind[struct {
					Chat  string
					Last  int
					Tools bool
				}](raw)
				if err != nil {
					return "", err
				}
				c, err := s.loadChat(chatLocOf(sc.Root), a.Chat)
				if err != nil || !s.mcpChatInspectable(sc, c) {
					return "", errMCPConversation
				}
				data, err := json.Marshal(c)
				if err != nil {
					return "", err
				}
				text := conversationText(data, a.Last, a.Tools) + pendingQuestions(c, "The user can answer in the Questions tool of the IDE.")
				if details := mcpInspectionDetails(sc, c); details != "" {
					text = details + "\n\n" + text
				}
				if sc.ACPParent != "" && (sc.RefreshACPGrant == nil || !sc.RefreshACPGrant()) {
					return "", errMCPConversation
				}
				if c.Delegation != nil {
					text = delegationCut(text)
				}
				return text, nil
			},
		},
		{
			Name:        "assistant_send",
			Description: "Sends or queues a message to the Assistant. ACP delegation returns the turn id for assistant_wait.",
			Props:       map[string]any{"chat": chat, "message": message},
			Required:    []string{"chat", "message"},
			Run: func(_ context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
				a, err := bind[struct{ Chat, Message string }](raw)
				if err != nil {
					return "", err
				}
				return s.reply(sc, chatLocOf(sc.Root), sc.Root.ID, sc.Here.ID, sc.Lang, a.Chat, a.Message, assistant.AuthorMCP)
			},
		},
		{
			Name:        "assistant_start",
			Description: "Starts an Assistant conversation in the project of cwd. For ACP, starts bounded analysis on the configured sub-agent model and returns chat and turn ids.",
			Props: map[string]any{
				"message": message,
				"title":   plugins.Str("Conversation title, optional"),
				"mode":    plugins.Enum("Assistant mode, ACP allows analysis or plan only", "analysis", engine.Briefing, engine.Plan, engine.Build, engine.Orchestrator),
				"server":  plugins.Str("Model server id, optional with model"),
				"model":   plugins.Str("Model id, optional with server"),
			},
			Required: []string{"message"},
			Run:      s.startMCPConversation,
		},
	}
}

func (s *A) startMCPConversation(ctx context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
	a, err := bind[struct{ Message, Title, Mode, Server, Model string }](raw)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(a.Message) == "" {
		return "", i18n.New("message is empty")
	}
	if sc.ACPParent != "" {
		if a.Mode != "" && a.Mode != "analysis" && a.Mode != engine.Plan {
			return "", i18n.New("ACP Assistant delegation requires analysis mode")
		}
		if len(a.Message) > delegationPromptBytes || len(a.Title) > delegationPromptBytes {
			return "", i18n.New("Assistant delegation input exceeds 16 KiB")
		}
		server, model, err := s.delegationModel(ctx, a.Server, a.Model)
		if err != nil {
			return "", err
		}
		c := &engine.Chat{MCPOwner: sc.Identity, MCPProject: sc.Here.ID, Delegation: &engine.Delegation{Parent: sc.ACPParent},
			ID: assistant.NewID(), Title: strings.TrimSpace(a.Title), Mode: engine.Plan, Server: server, Model: model}
		c.AddUser(&engine.Message{Role: "user", Content: assistant.String(a.Message), Display: a.Message, Author: assistant.AuthorMCP})
		if err := s.startMCPDelegation(sc, c, 0); err != nil {
			return "", err
		}
		return delegationText(c, "running"), nil
	}
	switch a.Mode {
	case "":
		a.Mode = engine.Build
	case engine.Briefing, engine.Plan, engine.Build, engine.Orchestrator:
	default:
		return "", i18n.Errorf("unknown mode: %s", a.Mode)
	}
	if a.Server == "" && a.Model == "" {
		view := s.LLM.View()
		a.Server, _ = view["server"].(string)
		a.Model, _ = view["model"].(string)
	}
	if a.Server == "" || a.Model == "" {
		return "", i18n.New("Choose a server and a model")
	}
	if !s.modelInfo(ctx, a.Server, a.Model).found {
		return "", i18n.Errorf("model %q is not available on server %q", a.Model, a.Server)
	}
	c := &engine.Chat{MCPOwner: sc.Identity, MCPProject: sc.Here.ID, MCPTextOnly: sc.Supervisor, ID: assistant.NewID(), Title: strings.TrimSpace(a.Title), Mode: a.Mode, Server: a.Server, Model: a.Model}
	c.AddUser(&engine.Message{Role: "user", Content: assistant.String(a.Message), Display: a.Message, Author: assistant.AuthorMCP})
	if err := s.startRun(chatLocOf(sc.Root), sc.Root.ID, sc.Here.ID, sc.Lang, c, 0); err != nil {
		return "", err
	}
	return c.ID, nil
}

// Only assistant_list and assistant_read accept the Supervisor's inspection grant.
func (s *A) mcpChatInspectable(sc plugins.MCPScope, c *engine.Chat) bool {
	if sc.Supervisor && c.Delegation != nil {
		if c.Delegation.Parent == "" || sc.AllowsProject == nil || !sc.AllowsProject(c.MCPProject, sc.Root.ID) {
			return false
		}
		root, err := s.Projects.Root(c.MCPProject)
		return err == nil && root.ID == sc.Root.ID
	}
	return s.mcpChatAllowed(sc, c)
}

func mcpInspectionDetails(sc plugins.MCPScope, c *engine.Chat) string {
	d := c.Delegation
	if !sc.Supervisor || d == nil {
		return ""
	}
	details := "ACP parent " + d.Parent
	if d.Turn != "" {
		details += " · turn " + d.Turn
	}
	if d.State != "" {
		details += " · state " + d.State
	}
	return details
}

// An existing chat has the scope of its owner project, not the cwd a client supplies.
func (s *A) mcpChatAllowed(sc plugins.MCPScope, c *engine.Chat) bool {
	return mcpChatAllowedIn(sc, c, s.runProject(c, sc.Root.ID, sc.Root.ID))
}

func mcpChatAllowedIn(sc plugins.MCPScope, c *engine.Chat, project string) bool {
	if c.Delegation != nil || sc.ACPParent != "" {
		return c.Delegation != nil && sc.ACPParent != "" && c.Delegation.Parent == sc.ACPParent &&
			c.MCPOwner == sc.Identity && c.MCPProject == sc.Here.ID && project == c.MCPProject &&
			sc.AllowsProject != nil && sc.AllowsProject(project, sc.Root.ID) &&
			sc.RefreshACPGrant != nil && sc.RefreshACPGrant()
	}
	if sc.Supervisor && (c.MCPOwner != sc.Identity || !c.MCPTextOnly) {
		return false
	}
	return sc.AllowsProject == nil || sc.AllowsProject(project, sc.Root.ID)
}

// Recover an interrupted manual conversation only after checking its grant.
func (s *A) openMCPChatForTurn(sc plugins.MCPScope, id string) (*engine.Chat, error) {
	c, err := s.loadMCPChat(sc, id)
	if err != nil || c.Delegation != nil || c.Running == nil && c.Approval == nil {
		return c, err
	}
	c, err = s.openChat(chatCtx{chatLocOf(sc.Root), sc.Root.ID}, id)
	if err != nil || !s.mcpChatAllowed(sc, c) {
		return nil, errMCPConversation
	}
	return c, nil
}
