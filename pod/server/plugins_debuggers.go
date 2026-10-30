package server

import (
	"context"
	"path/filepath"
	"slices"
	"strings"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/execx"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/plugins/install"
	"antennae.space/ide/pod/runtime"
)

// The debug adapters of the language packs (#188, docs/design/debug.md): the debug host runs
// them, and the core builds their command. Unlike a language server, an adapter is **not
// confined**: it traces a process (ptrace), opens sockets and runs the user's program. The grant
// debugger:<type> is what says so, and it is the trust of a saved command run in a console — it
// is the user's program. On an SSH project the adapter runs on the host of the project, through
// its runner, as the servers do.

// PackDebuggers are the debug adapters of the installed packs a project uses (all for nil rt).
func (p podLend) PackDebuggers(rt *runtime.Runtime) []plugins.PackDebugger {
	var on map[string]bool
	if rt != nil {
		on = plugins.Enabled(p.s.pluginStates(rt))
	}
	var out []plugins.PackDebugger
	for _, e := range p.s.Plugins.Externals() {
		if rt != nil && !on[e.Manifest.ID] {
			continue
		}
		for _, d := range e.Manifest.Contributes.Debuggers {
			out = append(out, plugins.PackDebugger{Pack: e.Manifest.ID, PackName: e.Manifest.Name, Debugger: d})
		}
	}
	return out
}

// PackDebuggerServers are the adapters of the packs the project of rt uses, found or missing,
// and how the IDE installs them (the same list as a pack's servers, for Settings and the Debug
// tool).
func (p podLend) PackDebuggerServers(rt *runtime.Runtime) []plugins.PackDebuggerServer {
	var out []plugins.PackDebuggerServer
	for _, d := range p.PackDebuggers(rt) {
		packName := d.Pack
		if e, ok := p.s.Plugins.External(d.Pack); ok {
			packName = e.Manifest.Name
		}
		ps := plugins.PackDebuggerServer{Pack: d.Pack, PackName: packName, Type: d.Debugger.Type, Label: d.Debugger.Label, Program: programOf(d.Debugger.Argv)}
		ps.Path = p.s.findProgram(context.Background(), rt, d.Pack, ps.Program)
		if d.Debugger.Install != nil {
			ps.Install = d.Debugger.Install
			ps.Command = installCommand(d.Pack, *d.Debugger.Install)
			if m := managerProgram(d.Debugger.Install.Manager); !hasProgram(rt, m) {
				ps.Needs = m
			}
		}
		out = append(out, ps)
	}
	return out
}

// programOf is the program of an argv (the bare name the pack names).
func programOf(argv []string) string {
	if len(argv) == 0 {
		return ""
	}
	return argv[0]
}

// DebuggerCommand is the command starting the adapter d of the pack on the project of rt: the
// program of the pack's folder of tools or of the PATH, with the folders and variables the pack
// names added to its environment. Not confined: the grant debugger:<type> was accepted for it.
func (p podLend) DebuggerCommand(rt *runtime.Runtime, pack string, d plugins.Debugger) ([]string, error) {
	return p.s.debuggerCommand(rt, pack, d)
}

func (s *Server) debuggerCommand(rt *runtime.Runtime, pack string, d plugins.Debugger) ([]string, error) {
	e, ok := s.Plugins.External(pack)
	if !ok {
		return nil, i18n.Errorf("the plugin %s is not installed", pack)
	}
	if len(d.Argv) == 0 {
		return nil, i18n.Errorf("%s has no adapter", d.Type)
	}
	if !slices.Contains(e.Grants, "debugger:"+d.Type) {
		return nil, i18n.Errorf("%s is not granted to %s", "debugger:"+d.Type, e.Manifest.Name)
	}
	prog := d.Argv[0]
	// The pack's folder of tools first, then the PATH (#153).
	if s.findProgram(context.Background(), rt, pack, prog) == "" {
		return nil, i18n.Errorf("%s is not installed (not found on the PATH)", prog)
	}
	// The folders the adapter needs, resolved on this machine (the grant path:<name> says the
	// pack may read them); their bin folders come first on its PATH, a folder with env is also a
	// variable of its environment.
	var dirs []string
	env := map[string]string{}
	if rt.Local {
		host := install.ThisHost(s.Store.Path())
		for _, g := range d.Paths {
			if !slices.Contains(e.Grants, "path:"+g.Name) {
				return nil, i18n.Errorf("%s is not granted to %s", "path:"+g.Name, e.Manifest.Name)
			}
			dir, err := host.ResolvePath(g)
			if err != nil {
				return nil, err
			}
			for _, pd := range d.PathDirs {
				name, rest, _ := strings.Cut(pd, "/")
				if name == g.Name {
					dirs = append(dirs, filepath.Join(dir, rest))
				}
			}
			if g.Env {
				env[g.Name] = dir
			}
		}
	} else {
		// On the host of the project: the pack's folder of tools comes first on its PATH
		// (remotePath), and a folder the pack names stays a variable of the host's environment.
		for _, g := range d.Paths {
			if g.Env {
				env[g.Name] = "$" + g.Name
			}
		}
	}
	keys := make([]string, 0, len(d.Env))
	for k := range d.Env {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		env[k] = d.Env[k]
	}
	// A shell sets the environment and execs the adapter: the user's own environment stays
	// there (an adapter runs the user's program, it needs their PATH, their HOME, their keys).
	var parts []string
	if len(dirs) > 0 {
		// The folders first, then the PATH of the machine: quoted, but $PATH left to the shell.
		parts = append(parts, `PATH=`+execx.Quote(strings.Join(dirs, ":")+`:`)+`$PATH`)
	}
	for _, k := range sortedKeys(env) {
		v := env[k]
		if strings.HasPrefix(v, "$") {
			parts = append(parts, k+"="+v) // a variable of the host, expanded there
		} else {
			parts = append(parts, k+"="+execx.Quote(v))
		}
	}
	line := strings.Join(parts, " ")
	if line != "" {
		line += " "
	}
	if d.Transport == "tcp" {
		// The adapter speaks DAP on the port: its error output goes with its standard one, so
		// the host can show why it did not start.
		line += `exec 2>&1; `
	}
	if !rt.Local {
		line = remotePath(pack) + line
	}
	return append([]string{"sh", "-c", line + `exec "$0" "$@"`}, d.Argv...), nil
}

// sortedKeys are the keys of a map, in order (a command shown to the user stays the same).
func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// InstallDebugger runs the recipe of an adapter of a pack in a console of the project, into the
// pack's folder of tools, as for a server (#153).
func (p podLend) InstallDebugger(rt *runtime.Runtime, pack, dtype string) (string, error) {
	for _, d := range p.PackDebuggers(rt) {
		if d.Pack != pack || d.Debugger.Type != dtype || d.Debugger.Install == nil {
			continue
		}
		if m := managerProgram(d.Debugger.Install.Manager); !hasProgram(rt, m) {
			return "", i18n.Errorf("%s is needed to install %s", m, programOf(d.Debugger.Argv))
		}
		line := installCommand(pack, *d.Debugger.Install)
		info, err := rt.Consoles.Create("task", "Install "+programOf(d.Debugger.Argv), []string{"sh", "-c", line}, rt.Root, 120, 30)
		if err != nil {
			return "", err
		}
		p.s.emitter(rt.P.ID)("console.created", info, "")
		return info.ID, nil
	}
	return "", i18n.Errorf("%s has no install recipe in %s", dtype, pack)
}
