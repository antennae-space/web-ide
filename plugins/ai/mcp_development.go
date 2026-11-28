package ai

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/fsx"
	"antennae.space/ide/pod/runtime"
)

// Use the same allowlist for model tool discovery and dispatch. The grant is for this
// development's worktree and ticket. Shell commands also require the user to approve them.
func mcpDevelopmentTool(name string) bool {
	switch name {
	case "list_dir", "find_files", "read_file", "edit_file", "write_file", "bash", "ask_user",
		"kanban_get", "kanban_goal", "kanban_move", "kanban_add_note", "kanban_feedback":
		return true
	}
	return false
}

func mcpAnalysisTool(name string) bool {
	return name == "read_file" || name == "list_dir" || name == "ask_user"
}

// The MCP grant limits which resources the conversation can access. Conversation
// actions use the Assistant's normal settings and approved model.
func mcpAssistantToolAllowed(c *engine.Chat, name string) bool {
	if c.MCPTextOnly {
		return false
	}
	if name == "compact_conversation" || name == "set_effort" {
		return true
	}
	switch {
	case c.MCPDevelopment:
		return mcpDevelopmentTool(name)
	case c.Delegation != nil:
		return mcpAnalysisTool(name)
	case c.MCPProject != "":
		return name == "ask_user"
	default:
		return true
	}
}

// Start from the standard Assistant definitions, then apply the caller's
// existing resource boundary. Dispatch checks the same boundary.
func mcpScopedDefs(c *engine.Chat, defs []json.RawMessage) []json.RawMessage {
	if c.MCPProject == "" && c.Delegation == nil && !c.MCPTextOnly && !c.MCPDevelopment {
		return defs
	}
	var out []json.RawMessage
	for _, d := range defs {
		var f struct {
			Function struct{ Name string } `json:"function"`
		}
		if json.Unmarshal(d, &f) == nil && mcpAssistantToolAllowed(c, f.Function.Name) {
			out = append(out, d)
		}
	}
	return out
}

// Analysis reads through an os.Root, so a path swapped after validation cannot
// leave the worktree. The registered project check also excludes nested projects.
func (s *A) mcpAnalysisFile(rt *runtime.Runtime, name string, a assistant.Args) (assistant.ToolResult, error) {
	path := assistant.AbsPath(rt.Root, a.Str("path"))
	if err := checkMCPWorktreePath(rt.Root, path); err != nil {
		return assistant.ToolResult{}, err
	}
	rel, _ := filepath.Rel(rt.Root, path)
	p, ok := s.Projects.At(path)
	data := s.Store.Dir()
	worktrees := filepath.Join(rt.Root, ".ide", "worktrees")
	if !ok || p.ID != rt.P.ID || fsx.Within(data, path) || fsx.Within(worktrees, path) ||
		rel == ".git" || strings.HasPrefix(rel, ".git"+string(filepath.Separator)) {
		return assistant.ToolResult{}, i18n.New("the path is outside the Assistant delegation")
	}
	dir, err := os.OpenRoot(rt.Root)
	if err != nil {
		return assistant.ToolResult{}, err
	}
	defer dir.Close()
	if name == "list_dir" {
		entries, err := fs.ReadDir(dir.FS(), rel)
		if err != nil {
			return assistant.ToolResult{}, err
		}
		var list []fsx.Entry
		for _, entry := range entries {
			child := filepath.Join(path, entry.Name())
			p, ok := s.Projects.At(child)
			if !ok || p.ID != rt.P.ID || entry.Name() == ".git" || fsx.Within(data, child) || fsx.Within(worktrees, child) ||
				!entry.IsDir() && !entry.Type().IsRegular() {
				continue
			}
			if info, err := entry.Info(); err == nil {
				list = append(list, fsx.Entry{Name: entry.Name(), Dir: entry.IsDir(), Size: info.Size()})
			}
		}
		return formatAssistantDir(rel, list), nil
	}
	if a.Str("path") == "" {
		return assistant.ToolResult{}, assistant.Usagef("path is missing")
	}
	f, err := dir.Open(rel)
	if err != nil {
		return assistant.ToolResult{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	const maxRead = 10 << 20
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxRead {
		return assistant.ToolResult{}, i18n.New("the path must be a regular text file in the worktree")
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxRead+1))
	if err != nil {
		return assistant.ToolResult{}, err
	}
	content, _, ok := runtime.DecodeText(raw)
	if !ok || len(raw) > maxRead {
		return assistant.ToolResult{}, i18n.New("the path must be a regular text file in the worktree")
	}
	return formatAssistantFile(rel, content, a.Num("start_line"), a.Num("end_line")), nil
}

func checkMCPDevelopmentTool(rt *runtime.Runtime, ticket *engine.TicketLink, name string, a assistant.Args) error {
	switch name {
	case "kanban_get":
		var id int64
		if json.Unmarshal(a["id"], &id) != nil || ticket == nil || ticket.ID != id {
			return errors.New("the ticket is outside this MCP development")
		}
	case "list_dir", "read_file", "edit_file", "write_file":
		return checkMCPWorktreePath(rt.Root, a.Str("path"))
	case "bash":
		return checkMCPWorktreePath(rt.Root, a.Str("cwd"))
	}
	return nil
}

func checkMCPWorktreePath(root, name string) error {
	rel, err := filepath.Rel(root, assistant.AbsPath(root, name))
	if err != nil || !filepath.IsLocal(rel) {
		return errors.New("the path is outside the ticket worktree")
	}
	dir, err := os.OpenRoot(root)
	if err != nil {
		return err
	}
	defer dir.Close()
	// Check the existing path components. Missing directories can be created by write_file.
	for p := rel; p != "."; p = filepath.Dir(p) {
		info, err := dir.Lstat(p)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return errors.New("the path is not accessible in the ticket worktree")
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return errors.New("the path must use regular files or directories in the ticket worktree")
		}
	}
	return nil
}
