package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/plugins/confine"
	"antennae.space/ide/pod/plugins/install"
	"antennae.space/ide/pod/runtime"
)

// The language packs (#145, docs/design/plugins.md, *Language packs*): external plugins giving
// the language host their languages. Their servers run confined on this machine (the pack's
// grants: its program, the folders of the host it needs), or as their granted program on the
// host of an SSH project, where nothing confines them.

// PackLanguages are the languages of the installed packs a project uses (all for nil rt).
func (p podLend) PackLanguages(rt *runtime.Runtime) []plugins.PackLanguage {
	var on map[string]bool
	if rt != nil {
		on = plugins.Enabled(p.s.pluginStates(rt))
	}
	var out []plugins.PackLanguage
	for _, e := range p.s.Plugins.Externals() {
		if rt != nil && !on[e.Manifest.ID] {
			continue
		}
		for _, l := range e.Manifest.Contributes.Languages {
			out = append(out, plugins.PackLanguage{Pack: e.Manifest.ID, Language: l})
		}
	}
	return out
}

// PackCommand is the command of a server of a pack on the project of rt.
func (p podLend) PackCommand(rt *runtime.Runtime, pack string, sv plugins.LanguageServer) ([]string, error) {
	return p.s.packCommand(rt, pack, sv)
}

func (s *Server) packCommand(rt *runtime.Runtime, pack string, sv plugins.LanguageServer) ([]string, error) {
	e, ok := s.Plugins.External(pack)
	if !ok {
		return nil, i18n.Errorf("the plugin %s is not installed", pack)
	}
	if len(sv.Argv) == 0 || !slices.Contains(e.Grants, "program:"+sv.Argv[0]) {
		return nil, i18n.Errorf("%s is not granted to %s", "program:"+strings.Join(sv.Argv[:min(1, len(sv.Argv))], ""), e.Manifest.Name)
	}
	if !rt.Local {
		// On the host of the project: the program by its name, no shell.
		return slices.Clone(sv.Argv), nil
	}
	if confine.ABI() < 1 {
		return nil, i18n.New("this kernel has no Landlock: an external plugin's backend cannot run confined")
	}
	host := install.ThisHost(s.Store.Path())
	prog, err := host.ResolveProgram(sv.Argv[0])
	if err != nil {
		return nil, err
	}
	data := s.Store.Path("plugin-data", pack)
	if err := os.MkdirAll(filepath.Join(data, "tmp"), 0o700); err != nil {
		return nil, err
	}
	read, write := []string{prog}, []string{}
	env := []string{"HOME=" + data, "TMPDIR=" + filepath.Join(data, "tmp"), "LANG=C.UTF-8"}
	resolved := map[string]string{}
	for _, g := range sv.Paths {
		if !slices.Contains(e.Grants, "path:"+g.Name) {
			return nil, i18n.Errorf("%s is not granted to %s", "path:"+g.Name, e.Manifest.Name)
		}
		dir, err := host.ResolvePath(g)
		if err != nil {
			return nil, err
		}
		resolved[g.Name] = dir
		if g.Access == "write" {
			write = append(write, dir)
		} else {
			read = append(read, dir)
		}
		if g.Env {
			env = append(env, g.Name+"="+dir)
		}
	}
	keys := make([]string, 0, len(sv.Env))
	for k := range sv.Env {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		env = append(env, k+"="+sv.Env[k])
	}
	path := []string{}
	for _, d := range sv.PathDirs {
		name, rest, _ := strings.Cut(d, "/")
		path = append(path, filepath.Join(resolved[name], rest))
	}
	env = append(env, "PATH="+strings.Join(append(path, "/usr/local/bin", "/usr/bin", "/bin"), ":"))
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(s.plugins.installer.Dir(pack), e.Version)
	// env -i: the server gets this environment only, not the pod's.
	argv := append([]string{"/usr/bin/env", "-i"}, env...)
	argv = append(argv, exe, "plugin-exec", "-plugin", dir, "-data", data, "-project", rt.Root, "-read", strings.Join(read, ":"))
	if len(write) > 0 {
		argv = append(argv, "-writedir", strings.Join(write, ":"))
	}
	if slices.Contains(e.Grants, "net") {
		argv = append(argv, "-net")
	}
	return append(append(argv, "--", prog), sv.Argv[1:]...), nil
}

// packTests are the test patterns of the installed packs for an extension.
func (s *Server) packTests(ext string) []string {
	var out []string
	for _, e := range s.Plugins.Externals() {
		for _, l := range e.Manifest.Contributes.Languages {
			if pat := l.Tests[ext]; pat != "" {
				out = append(out, pat)
			}
		}
	}
	return out
}

// maxGrammar caps the grammar file of a pack.
const maxGrammar = 1 << 20

// packGrammars are the languages of the installed packs for the page: their grammars (the files
// of the packs, GrammarDefs of the editor), by language.
func (s *Server) packGrammars() []map[string]any {
	out := []map[string]any{}
	for _, e := range s.Plugins.Externals() {
		dir := filepath.Join(s.plugins.installer.Dir(e.Manifest.ID), e.Version)
		for _, l := range e.Manifest.Contributes.Languages {
			if l.Grammar == "" {
				continue
			}
			p := filepath.Join(dir, filepath.FromSlash(l.Grammar))
			st, err := os.Stat(p)
			if err != nil || !st.Mode().IsRegular() || st.Size() > maxGrammar {
				continue
			}
			data, err := os.ReadFile(p)
			var def map[string]any
			if err != nil || json.Unmarshal(data, &def) != nil {
				continue
			}
			// The pack's language: its id, name and extensions win over the file's.
			def["id"], def["name"], def["extensions"] = l.ID, l.Name, l.Extensions
			out = append(out, map[string]any{"pack": e.Manifest.ID, "grammar": def})
		}
	}
	return out
}
