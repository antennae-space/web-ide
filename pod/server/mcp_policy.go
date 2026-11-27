package server

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/plugins"
)

type mcpAccess struct {
	mcpIdentity
	mcpScope
}

type mcpAccessKey struct{}

func accessForMCP(ctx context.Context) mcpAccess {
	return ctx.Value(mcpAccessKey{}).(mcpAccess)
}

type mcpToolKind uint8

const (
	mcpCore mcpToolKind = iota
	mcpPlugin
	mcpAssistantTool
)

type mcpTarget struct {
	mcpTool
	plugin string
	kind   mcpToolKind
}

// Resolve both discovery and dispatch in the same order. A plugin cannot acquire
// permissions by declaring the name of a tool owned by the core or another plugin.
func (s *Server) mcpTargets() []mcpTarget {
	var out []mcpTarget
	for _, t := range mcpTools {
		out = append(out, mcpTarget{mcpTool: t, kind: mcpCore})
	}
	for _, p := range s.allMCPTools() {
		out = append(out, mcpTarget{plugin: p.plugin, kind: mcpPlugin, mcpTool: mcpTool{
			name: p.tool.Name, description: p.tool.Description, props: p.tool.Props, required: p.tool.Required,
			run: func(ctx context.Context, s *Server, raw json.RawMessage) (string, error) {
				return s.runPluginMCPTool(ctx, &p, raw)
			},
		}})
	}
	for _, p := range s.allPluginTools() {
		out = append(out, mcpTarget{plugin: p.plugin, kind: mcpAssistantTool, mcpTool: mcpTool{
			name: p.tool.Name, description: p.tool.Description, props: p.tool.Props, required: p.tool.Required,
			run: func(ctx context.Context, s *Server, raw json.RawMessage) (string, error) {
				_, _, rt, err := s.mcpIDE(ctx, raw)
				if err != nil {
					return "", err
				}
				return mcpText(s.runPluginTool(ctx, rt, &p, raw, "en", nil))
			},
		}})
	}
	return out
}

func (s *Server) mcpOfficial(id string) bool {
	e, ok := s.Plugins.External(id)
	return ok && e.Official && e.URL == "https://github.com/antennae-space/plugin-"+id
}

func (s *Server) allowsMCPTool(i mcpIdentity, t mcpTarget) bool {
	developer := i.Profile == mcpDeveloper
	if t.kind == mcpCore {
		switch t.name {
		case "list_consoles", "read_console", "list_commands", "list_previews", "show_message":
			return true
		case "run_saved_command", "console_input", "share_preview", "open_file", "open_diff", "focus", "request_doodle", "ask_user":
			return developer
		}
		return false
	}
	switch t.plugin {
	case "ai":
		if t.kind != mcpPlugin {
			return false
		}
		switch t.name {
		case "assistant_list", "assistant_read", "assistant_send", "assistant_start":
			return i.Assistant
		case "kanban_conversation":
			return developer
		case "kanban_reply", "kanban_answer":
			return developer && i.Assistant
		}
		return false
	case "kanban":
		if t.kind != mcpPlugin || !s.mcpOfficial(t.plugin) {
			return false
		}
		switch t.name {
		case "kanban_add_note", "kanban_create", "kanban_feedback", "kanban_get", "kanban_goal",
			"kanban_list", "kanban_milestone", "kanban_move", "kanban_objective", "kanban_set_plan", "kanban_update":
			return true
		case "kanban_start":
			// The released backend also runs saved setup commands during start.
			return developer && i.grantsWorktrees()
		}
		return false
	case "docker":
		// These tools can address any container on the host.
		return false
	case "database":
		if t.kind != mcpAssistantTool || !s.mcpOfficial(t.plugin) {
			return false
		}
		switch t.name {
		case "database_connections", "database_schema", "database_query":
			return true
		case "database_execute":
			return developer
		}
		return false
	}
	// Additional plugin tools are opt-in. The operator trusts the code of those
	// tools with Developer access to the project family.
	return developer && slices.Contains(i.PluginTools[t.plugin], t.name)
}

func (s *Server) authorizeMCPCall(ctx context.Context, i mcpIdentity, t mcpTarget, raw json.RawMessage) (context.Context, json.RawMessage, error) {
	var input assistant.Args
	if err := json.Unmarshal(raw, &input); err != nil {
		return ctx, nil, err
	}
	// Go structs match JSON field names case insensitively. Authorize the same
	// arguments the handler will see, including differently cased fields.
	a := make(assistant.Args, len(input))
	for name, value := range input {
		if strings.IndexFunc(name, func(r rune) bool { return r > 127 }) >= 0 {
			return ctx, nil, fmt.Errorf("MCP argument names must be ASCII")
		}
		name = strings.ToLower(name)
		if _, exists := a[name]; exists {
			return ctx, nil, fmt.Errorf("ambiguous tool argument %q", name)
		}
		a[name] = value
	}
	sc, err := s.mcpScope(a.Str("cwd"))
	if err != nil {
		return ctx, nil, err
	}
	if !i.matches(sc) {
		return ctx, nil, fmt.Errorf("MCP credential is not granted this project")
	}
	access := mcpAccess{i, sc}
	ctx = context.WithValue(ctx, mcpAccessKey{}, access)
	if err := s.authorizeMCPResource(ctx, access, t, a); err != nil {
		return ctx, nil, err
	}
	args, err := json.Marshal(a)
	return ctx, args, err
}

func (s *Server) authorizeMCPResource(ctx context.Context, ac mcpAccess, t mcpTarget, a assistant.Args) error {
	switch t.name {
	case "open_file", "open_diff", "focus":
		if t.name == "focus" && a.Str("target") != "file" {
			break
		}
		path := a.Str("path")
		if !filepath.IsAbs(path) {
			path = filepath.Join(a.Str("cwd"), path)
		}
		fileScope, err := s.mcpPathScope(path)
		if err != nil || fileScope.here.ID != ac.here.ID {
			return fmt.Errorf("file is outside the MCP project")
		}
		a["path"], _ = json.Marshal(path)
	}
	if t.plugin == "kanban" || t.plugin == "ai" && slices.Contains([]string{"kanban_conversation", "kanban_reply", "kanban_answer"}, t.name) {
		if err := authorizeKanbanOperation(ac, t.name, a); err != nil {
			return err
		}
		if !ac.Projects[ac.root.ID] && ac.here.ID != ac.root.ID {
			switch t.name {
			case "kanban_list", "kanban_milestone", "kanban_objective", "kanban_create", "kanban_start":
				return fmt.Errorf("this tool requires a grant on the main project and its worktrees")
			}
			if t.name == "kanban_update" && (a["parent"] != nil || a["depends_on"] != nil || a["milestone"] != nil || a["objective"] != nil) {
				return fmt.Errorf("changing lineage requires a main project grant")
			}
			if err := s.authorizeMCPTicket(ctx, ac, a); err != nil {
				return err
			}
		}
	} else if t.plugin != "" && t.plugin != "ai" && ac.here.ID != ac.root.ID && !ac.Projects[ac.root.ID] {
		return fmt.Errorf("this plugin tool requires a grant on the main project")
	}
	return nil
}

func authorizeKanbanOperation(ac mcpAccess, name string, a assistant.Args) error {
	var actions []string
	switch name {
	case "kanban_start":
		if !ac.Projects[ac.root.ID] {
			return fmt.Errorf("starting development requires a grant on the main project and its worktrees")
		}
	case "kanban_move":
		actions = []string{"to_test", "review"}
		if ac.Profile == mcpDeveloper && (ac.Projects[ac.root.ID] || ac.here.ID != ac.root.ID) {
			actions = append(actions, "done")
		}
		if !slices.Contains(actions, a.Str("status")) {
			return fmt.Errorf("ticket status is not allowed by the MCP profile")
		}
	case "kanban_goal":
		actions = []string{"add", "edit", "check", "uncheck", "delete"}
	case "kanban_feedback":
		actions = []string{"add", "done", "reopen"}
	case "kanban_milestone":
		actions = []string{"list", "get", "create", "update", "story_add", "story_edit", "story_delete", "feedback_add", "feedback_done", "feedback_reopen", "note"}
	case "kanban_objective":
		actions = []string{"list", "get", "create", "update", "note"}
	}
	if name != "kanban_move" && actions != nil && !slices.Contains(actions, a.Str("action")) {
		return fmt.Errorf("Kanban action is not allowed by the MCP profile")
	}
	return nil
}

func (s *Server) authorizeMCPTicket(ctx context.Context, ac mcpAccess, a assistant.Args) error {
	if ac.ticket == 0 {
		return fmt.Errorf("this tool requires a ticket worktree or a main project grant")
	}
	var id int64
	if raw := a["id"]; raw != nil {
		if err := json.Unmarshal(raw, &id); err != nil || id < 0 {
			return fmt.Errorf("invalid ticket number")
		}
	}
	if id == 0 || id == ac.ticket {
		return nil // the backend selects the lineage's current step when id is absent
	}
	var ticket struct {
		Parent int64
	}
	raw, err := (podLend{s}).CallPlugin(ctx, ac.here.ID, "kanban.get", map[string]any{"id": id})
	if err != nil || json.Unmarshal(raw, &ticket) != nil || ticket.Parent != ac.ticket {
		return fmt.Errorf("ticket is outside the MCP worktree")
	}
	return nil
}

func (s *Server) mcpPluginScope(ctx context.Context) plugins.MCPScope {
	a := accessForMCP(ctx)
	return plugins.MCPScope{Here: a.here, Root: a.root, Ticket: a.ticket, URL: s.publicURL(), Lang: s.uiLanguage(),
		Identity: a.key, Supervisor: a.Profile == mcpSupervisor, AllowsProject: a.allows}
}
