package ai

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/pod/assistant"
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

func mcpDevelopmentDefs(c *engine.Chat) []json.RawMessage {
	var out []json.RawMessage
	for _, d := range engine.ToolsFor(c.Mode, c.Ticket, false, false, false) {
		var f struct {
			Function struct{ Name string } `json:"function"`
		}
		if json.Unmarshal(d, &f) == nil && mcpDevelopmentTool(f.Function.Name) {
			out = append(out, d)
		}
	}
	return out
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
