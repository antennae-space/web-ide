package server

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/execx"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/runtime"
)

// The servers of the language packs installed by the IDE (#153, docs/design/plugins.md,
// *Language packs*): a pack gives each server a recipe (a package manager the core knows and
// its packages); the core builds the command and runs it in a console the user sees, into the
// pack's folder of tools, $XDG_DATA_HOME/web-ide/tools/<pack> (~/.local/share/…: not under
// ~/.web-ide, so the pack's path grants may read it). Its bin folders come first on the PATH
// a pack's program is looked up with, on this machine as on the host of an SSH project.

// toolsShell is the folder of tools of a pack, as a shell expands it (the host's home).
func toolsShell(pack string) string {
	return `"${XDG_DATA_HOME:-$HOME/.local/share}/web-ide/tools/` + pack + `"`
}

// toolsDir is the folder of tools of a pack on this machine.
func toolsDir(pack string) string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "web-ide", "tools", pack)
}

// toolBins are the folders of programs of a folder of tools: npm, a virtualenv, GOBIN.
var toolBins = []string{"npm/bin", "venv/bin", "go/bin"}

// toolsPath is the PATH of this machine with the folders of tools of a pack first.
func toolsPath(pack string) string {
	var dirs []string
	for _, b := range toolBins {
		dirs = append(dirs, filepath.Join(toolsDir(pack), b))
	}
	return strings.Join(append(dirs, os.Getenv("PATH")), string(os.PathListSeparator))
}

// remotePath is the shell prefix putting the folders of tools of a pack first on the PATH of
// the host of an SSH project.
func remotePath(pack string) string {
	var dirs []string
	for _, b := range toolBins {
		dirs = append(dirs, `$D/`+b)
	}
	return `D=` + toolsShell(pack) + `; PATH="` + strings.Join(dirs, ":") + `:$PATH"; `
}

// managerProgram is the program a recipe needs on the machine.
func managerProgram(manager string) string {
	if manager == "pip" {
		return "python3"
	}
	return manager
}

// installCommand is the shell line installing a recipe into the folder of tools of a pack.
func installCommand(pack string, in plugins.ServerInstall) string {
	var pk []string
	for _, p := range in.Packages {
		pk = append(pk, execx.Quote(p))
	}
	pkgs := strings.Join(pk, " ")
	d := `D=` + toolsShell(pack) + ` && mkdir -p "$D" && `
	switch in.Manager {
	case "npm":
		return d + `npm install -g --prefix "$D/npm" --no-audit --no-fund ` + pkgs
	case "pip":
		return d + `python3 -m venv "$D/venv" && "$D/venv/bin/pip" install ` + pkgs
	case "go":
		return d + `GOBIN="$D/go/bin" go install ` + pkgs
	}
	return ""
}

// findProgram is where the program of a pack's server is on the project of rt ("" missing):
// the pack's folder of tools first, then the PATH.
func (s *Server) findProgram(ctx context.Context, rt *runtime.Runtime, pack, program string) string {
	if rt == nil || rt.Local {
		for _, dir := range filepath.SplitList(toolsPath(pack)) {
			p := filepath.Join(dir, program)
			if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
				return p
			}
		}
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := rt.Runner.Output(ctx, []string{"sh", "-c", remotePath(pack) + "command -v " + execx.Quote(program)}, "")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// hasProgram tells whether a program is on the PATH of the project's machine.
func hasProgram(rt *runtime.Runtime, name string) bool {
	if rt == nil || rt.Local {
		_, err := exec.LookPath(name)
		return err == nil
	}
	return rt.Runner.Has(name)
}

// PackServers are the servers of the packs the project of rt uses, found or missing (those of
// every installed pack, on this machine, for a nil rt).
func (p podLend) PackServers(rt *runtime.Runtime) []plugins.PackServer {
	var out []plugins.PackServer
	for _, l := range p.PackLanguages(rt) {
		packName := l.Pack
		if e, ok := p.s.Plugins.External(l.Pack); ok {
			packName = e.Manifest.Name
		}
		for _, sv := range l.Language.Servers {
			ps := plugins.PackServer{Pack: l.Pack, PackName: packName, Lang: l.Language.ID, Language: l.Language.Name, Program: sv.Argv[0], Install: sv.Install}
			ps.Path = p.s.findProgram(context.Background(), rt, l.Pack, sv.Argv[0])
			if sv.Install != nil {
				ps.Command = installCommand(l.Pack, *sv.Install)
				if m := managerProgram(sv.Install.Manager); !hasProgram(rt, m) {
					ps.Needs = m
				}
			}
			out = append(out, ps)
		}
	}
	return out
}

// InstallServer runs the recipe of a server of a pack in a console of the project.
func (p podLend) InstallServer(rt *runtime.Runtime, pack, program string) (string, error) {
	for _, l := range p.PackLanguages(rt) {
		if l.Pack != pack {
			continue
		}
		for _, sv := range l.Language.Servers {
			if sv.Argv[0] != program || sv.Install == nil {
				continue
			}
			if m := managerProgram(sv.Install.Manager); !hasProgram(rt, m) {
				return "", i18n.Errorf("%s is needed to install %s", m, program)
			}
			line := installCommand(pack, *sv.Install)
			info, err := rt.Consoles.Create("task", "Install "+program, []string{"sh", "-c", line}, rt.Root, 120, 30)
			if err != nil {
				return "", err
			}
			p.s.emitter(rt.P.ID)("console.created", info, "")
			return info.ID, nil
		}
	}
	return "", i18n.Errorf("%s has no install recipe in %s", program, pack)
}
