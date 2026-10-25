package server

import (
	"context"
	"encoding/json"
	"path"
	"slices"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/runtime"
)

// A program run for an external plugin on the host of an SSH project (#152, docs/design/
// plugins.md, *API bricks*): its backend runs on the pod, confined, and cannot reach that host;
// the core call `exec {argv, dir}` runs argv there through the project's connection, as the
// built-in plugins do, and answers its output. Each program is a grant, exec:<name>, accepted
// at the install; nothing confines it on the host. On a local project the backend runs its
// programs itself, confined: the call is refused there.

// maxExecOutput caps the output answered (a message is 8 MB at most).
const maxExecOutput = 4 << 20

func (s *Server) pluginExec(ctx context.Context, rt *runtime.Runtime, e plugins.External, params json.RawMessage) (any, error) {
	a, err := bind[struct {
		Argv []string `json:"argv"`
		Dir  string   `json:"dir"`
	}](params)
	if err != nil {
		return nil, err
	}
	if len(a.Argv) == 0 || a.Argv[0] == "" || path.Base(a.Argv[0]) != a.Argv[0] {
		return nil, i18n.New("exec: argv must start with the name of a program")
	}
	if !slices.Contains(e.Grants, "exec:"+a.Argv[0]) {
		return nil, i18n.Errorf("%s is not granted to %s", "exec:"+a.Argv[0], e.Manifest.Name)
	}
	if rt.Local {
		return nil, i18n.New("exec runs a program on the host of an SSH project; on this machine, the backend runs it itself")
	}
	dir, err := rt.Abs(a.Dir)
	if err != nil {
		return nil, err
	}
	if dir != rt.Root && !within(dir, rt.Root) {
		return nil, i18n.Errorf("%s is outside the project", a.Dir)
	}
	out, err := rt.Runner.Output(ctx, a.Argv, dir)
	if err != nil {
		return nil, err
	}
	truncated := len(out) > maxExecOutput
	if truncated {
		out = out[:maxExecOutput]
	}
	return map[string]any{"output": string(out), "truncated": truncated}, nil
}

// within tells whether p is inside dir (both clean, slash separated).
func within(p, dir string) bool {
	return len(p) > len(dir) && p[:len(dir)] == dir && p[len(dir)] == '/'
}
