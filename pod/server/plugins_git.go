package server

import (
	"context"
	"encoding/json"
	"path"
	"slices"
	"strings"
	"time"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/commands"
	"antennae.space/ide/pod/execx"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/projects"
	"antennae.space/ide/pod/runtime"
)

// Git and the worktree projects for an external plugin (#157, docs/design/plugins.md, *What the
// Kanban adds to the API*). Git needs the user's keys and configuration, the worktrees are
// projects of the pod and their setup runs the user's commands: none of it fits a confined
// backend. The core runs them in the folders of the project, on grants: git (`git`, with
// options that would run another program refused), gh (`gh`, its pull requests only) and the
// worktree projects (`worktrees`).

// gitOptions are the options of git refused to a plugin: they run another program, or reach
// past the folder of the call.
var gitOptions = []string{"-C", "--git-dir", "--work-tree", "--exec-path", "--upload-pack", "--receive-pack", "--exec", "--ext-diff", "--textconv", "--output", "--config-env", "--namespace"}

// gitSafeConfig are the settings a plugin may give with -c.
var gitSafeConfig = []string{"core.quotepath", "color.ui"}

// checkGitArgs refuses what would make git run a program the plugin chooses.
func checkGitArgs(args []string) error {
	sub := ""
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.Contains(a, "ext::") {
			return i18n.Errorf("git: %s is refused to a plugin", a)
		}
		if a == "-c" {
			if i+1 >= len(args) {
				return i18n.New("git: -c needs a setting")
			}
			i++
			key, _, _ := strings.Cut(args[i], "=")
			if !slices.Contains(gitSafeConfig, strings.ToLower(key)) {
				return i18n.Errorf("git: the setting %s is refused to a plugin", key)
			}
			continue
		}
		for _, o := range gitOptions {
			if a == o || strings.HasPrefix(a, o+"=") {
				return i18n.Errorf("git: %s is refused to a plugin", o)
			}
		}
		if sub == "" && !strings.HasPrefix(a, "-") {
			sub = a
		}
	}
	switch sub {
	case "":
		return i18n.New("git: no command")
	case "config":
		if !slices.Contains(args, "--get") {
			return i18n.New("git config: only --get for a plugin")
		}
	case "filter-branch", "difftool", "mergetool", "daemon", "instaweb", "credential", "upload-pack", "receive-pack":
		return i18n.Errorf("git %s is refused to a plugin", sub)
	}
	return nil
}

// projectDir is a folder a plugin's git runs in: the main folder of the project of rt, or one of
// its worktrees (.ide/worktrees/<name>).
func (s *Server) projectDir(rt *runtime.Runtime, dir string) (string, *projects.Project, error) {
	root, err := s.Projects.Root(rt.P.ID)
	if err != nil {
		return "", nil, err
	}
	if dir == "" {
		return root.Path, root, nil
	}
	if !path.IsAbs(dir) {
		dir = path.Join(root.Path, dir)
	}
	dir = path.Clean(dir)
	ide := path.Join(root.Path, ".ide")
	if dir == root.Path || within(dir, root.Path) && dir != ide && !within(dir, ide) || within(dir, path.Join(ide, "worktrees")) {
		return dir, root, nil
	}
	return "", nil, i18n.Errorf("%s is outside the project", dir)
}

// pluginGit runs git {args, dir?} (grant git) or gh {args, dir?} (grant gh: its pull requests).
func (s *Server) pluginGit(ctx context.Context, rt *runtime.Runtime, e plugins.External, prog string, params json.RawMessage) (any, error) {
	if !slices.Contains(e.Grants, prog) {
		return nil, i18n.Errorf("%s is not granted to %s", prog, e.Manifest.Name)
	}
	a, err := bind[struct {
		Args []string `json:"args"`
		Dir  string   `json:"dir"`
		// AnyExit: the output and the exit code whatever it is (git diff --no-index exits 1 on a
		// difference), an error only when git could not run.
		AnyExit bool `json:"anyExit"`
	}](params)
	if err != nil {
		return nil, err
	}
	if prog == "git" {
		err = checkGitArgs(a.Args)
	} else if len(a.Args) == 0 || (a.Args[0] != "pr" && !(len(a.Args) == 1 && a.Args[0] == "--version")) {
		err = i18n.New("gh: only its pull requests (gh pr …) for a plugin")
	}
	if err != nil {
		return nil, err
	}
	dir, _, err := s.projectDir(rt, a.Dir)
	if err != nil {
		return nil, err
	}
	if prog == "gh" && !rt.Runner.Has("gh") {
		return nil, i18n.New("gh is not installed")
	}
	out, err := rt.Runner.Output(ctx, append([]string{prog}, a.Args...), dir)
	exit := 0
	if err != nil {
		if exit = execx.ExitCode(err); !a.AnyExit || exit < 0 {
			return nil, err
		}
	}
	truncated := len(out) > maxExecOutput
	if truncated {
		out = out[:maxExecOutput]
	}
	return map[string]any{"output": string(out), "truncated": truncated, "exit": exit}, nil
}

// pluginWorktree runs the core calls of the worktree projects (grant worktrees):
// worktree.register {owner, title, path} → {project}, worktree.unregister {owner},
// worktree.setup {path} → {output, ok}, ide.keepOut {}.
func (s *Server) pluginWorktree(ctx context.Context, rt *runtime.Runtime, e plugins.External, method string, params json.RawMessage) (any, error) {
	if !slices.Contains(e.Grants, "worktrees") {
		return nil, i18n.Errorf("%s is not granted to %s", "worktrees", e.Manifest.Name)
	}
	a, err := bind[struct {
		Owner int64  `json:"owner"`
		Title string `json:"title"`
		Path  string `json:"path"`
	}](params)
	if err != nil {
		return nil, err
	}
	root, err := s.Projects.Root(rt.P.ID)
	if err != nil {
		return nil, err
	}
	// A folder of .ide/worktrees, the only place of the worktree projects of a plugin.
	worktree := func() (string, error) {
		dir, _, err := s.projectDir(rt, a.Path)
		if err != nil || !within(dir, path.Join(root.Path, ".ide", "worktrees")) {
			return "", i18n.Errorf("%s is not a folder of .ide/worktrees", a.Path)
		}
		return dir, nil
	}
	switch method {
	case "worktree.register":
		dir, err := worktree()
		if err != nil {
			return nil, err
		}
		if a.Owner <= 0 {
			return nil, i18n.New("worktree.register: owner, the number of its ticket")
		}
		v, err := s.Projects.PutChild(root, a.Owner, a.Title, dir)
		if err != nil {
			return nil, err
		}
		s.broadcast("projects.changed", nil, nil)
		return map[string]any{"project": v.ID}, nil
	case "worktree.unregister":
		child := projects.ChildID(root.ID, a.Owner)
		if _, ok := s.Projects.Get(child); ok {
			s.closeRuntime(child)
			_ = s.Projects.Delete(child)
			s.Desks.Delete(child)
			s.broadcast("projects.changed", nil, nil)
		}
		return map[string]any{}, nil
	case "worktree.setup":
		dir, err := worktree()
		if err != nil {
			return nil, err
		}
		list, err := s.projectCommands(rt)
		if err != nil {
			return nil, err
		}
		script := commands.SetupScript(list)
		if script == "" {
			return map[string]any{"output": "", "ok": true}, nil
		}
		ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
		defer cancel()
		out, err := rt.Runner.Output(ctx, []string{"sh", "-c", "(" + script + ") 2>&1"}, dir)
		res := map[string]any{"output": string(out), "ok": err == nil}
		if err != nil {
			res["error"] = err.Error()
		}
		return res, nil
	default: // ide.keepOut
		return map[string]any{}, rt.KeepIdeOut(root)
	}
}
