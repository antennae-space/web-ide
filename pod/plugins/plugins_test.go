package plugins

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"antennae.space/ide/pod/fsx"
)

type fake struct{ m Manifest }

func (f fake) Manifest() Manifest { m := f.m; m.APIVersion = APIVersion; return m }
func (f fake) Register(Host)      {}

func TestCheck(t *testing.T) {
	ok := Manifest{APIVersion: APIVersion, ID: "docker", Contributes: Contributions{Tools: []Tool{{ID: "dock", Zone: "right"}}, AssistantTools: []string{"docker_ps"}}}
	if err := ok.Check(); err != nil {
		t.Fatal(err)
	}
	for name, m := range map[string]Manifest{
		"id":      {ID: "Docker"},
		"api":     {ID: "x", APIVersion: 2},
		"zone":    {ID: "x", Contributes: Contributions{Tools: []Tool{{ID: "x", Zone: "top"}}}},
		"repeat":  {ID: "x", Contributes: Contributions{Tools: []Tool{{ID: "x", Zone: "left"}, {ID: "x", Zone: "left"}}}},
		"tool":    {ID: "x", Contributes: Contributions{AssistantTools: []string{"Bad name"}}},
		"tabview": {ID: "x", Contributes: Contributions{TabViews: []TabView{{ID: "a/b"}}}},
	} {
		if m.Check() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestAdd(t *testing.T) {
	r := NewRegistry()
	if err := r.Add(fake{Manifest{APIVersion: APIVersion, ID: "a", Contributes: Contributions{Tools: []Tool{{ID: "a", Zone: "left"}}, AssistantTools: []string{"a_x"}}}}); err != nil {
		t.Fatal(err)
	}
	for name, m := range map[string]Manifest{
		"twice":     {ID: "a"},
		"tool":      {ID: "b", Contributes: Contributions{Tools: []Tool{{ID: "a", Zone: "left"}}}},
		"core tool": {ID: "c", Contributes: Contributions{Tools: []Tool{{ID: "questions", Zone: "left"}}}},
		"assistant": {ID: "d", Contributes: Contributions{AssistantTools: []string{"a_x"}}},
		"mcp":       {ID: "e", Contributes: Contributions{MCPTools: []string{"a_x"}}},
	} {
		if r.Add(fake{m}) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if r.OwnerOf("a_x") != "a" || r.OwnerOf("bash") != "" || len(r.All()) != 1 {
		t.Fatal("registry", r.All())
	}
}

func TestResolve(t *testing.T) {
	r := NewRegistry()
	for _, m := range []Manifest{
		{ID: "db", Provides: []string{"sql"}},
		{ID: "orm", Requires: []string{"sql"}},
		{ID: "admin", Requires: []string{"sql"}},
		{ID: "lost", Requires: []string{"nothing"}},
	} {
		if err := r.Add(fake{m}); err != nil {
			t.Fatal(err)
		}
	}
	on := Enabled(r.Resolve(nil))
	if !on["db"] || !on["orm"] || !on["admin"] || on["lost"] {
		t.Fatal("all enabled", on)
	}
	states := r.Resolve([]string{"db"})
	on = Enabled(states)
	if len(on) != 0 {
		t.Fatal("db off turns orm and admin off", on)
	}
	if !states[0].Disabled || states[1].Disabled || !slices.Equal(states[1].Missing, []string{"sql"}) {
		t.Fatal("states", states)
	}
	if err := r.Add(fake{Manifest{ID: "core", Required: true}}); err != nil {
		t.Fatal(err)
	}
	if on := Enabled(r.Resolve([]string{"core"})); !on["core"] {
		t.Fatal("a required plugin cannot be disabled")
	}
	if d := Dependents(r.Resolve(nil), "db"); !slices.Equal(d, []string{"orm", "admin"}) {
		t.Fatal("dependents", d)
	}
}

func TestEnabledFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".ide")
	fs := fsx.Local{}
	if list, err := LoadDisabled(fs, dir); err != nil || len(list) != 0 {
		t.Fatal(list, err)
	}
	if _, err := SetEnabled(fs, dir, "docker", false); err != nil {
		t.Fatal(err)
	}
	if _, err := SetEnabled(fs, dir, "database", false); err != nil {
		t.Fatal(err)
	}
	ch, err := SetEnabled(fs, dir, "docker", true)
	if err != nil || !slices.Equal(ch.Disabled, []string{"database"}) {
		t.Fatal(ch, err)
	}
	if again, _ := LoadDisabled(fs, dir); !slices.Equal(again, ch.Disabled) {
		t.Fatal(again)
	}
	// An external plugin used by the project: kept beside the disabled ones.
	if ch, err = SetExternal(fs, dir, "greet", "https://example.test/greet"); err != nil || ch.External["greet"] == "" {
		t.Fatal(ch, err)
	}
	if ch, _ = SetEnabled(fs, dir, "git", false); ch.External["greet"] == "" || !slices.Equal(ch.Disabled, []string{"database", "git"}) {
		t.Fatal("the externals are kept", ch)
	}
	if ch, _ = SetExternal(fs, dir, "greet", ""); ch.External != nil {
		t.Fatal(ch)
	}
	if _, err := os.Stat(filepath.Join(dir, ".gitignore")); err != nil {
		t.Fatal(".ide kept out of git", err)
	}
	_ = os.WriteFile(filepath.Join(dir, "plugins.json"), []byte("{"), 0o644)
	if _, err := LoadDisabled(fs, dir); err == nil {
		t.Fatal("invalid file accepted")
	}
}

func TestBuiltinManifests(t *testing.T) {
	// The built-in plugins live in plugins/<id>/ at the root of the repository.
	files, _ := filepath.Glob("../../plugins/*/plugin.json")
	if len(files) < 10 {
		t.Fatal("built-in manifests not found:", files)
	}
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Parse(data); err != nil {
			t.Fatal(f, err)
		}
	}
}

// The external plugins are listed after the built-ins, never enabled in this step; one a
// project uses that the pod lacks shows as not installed.
func TestExternals(t *testing.T) {
	r := NewRegistry()
	if err := r.Add(fake{Manifest{ID: "git", Name: "Git", Version: "1.0.0", APIVersion: APIVersion, Contributes: Contributions{Tools: []Tool{{ID: "git", Label: "Git", Icon: "git", Zone: "left"}}}}}); err != nil {
		t.Fatal(err)
	}
	if err := r.SetExternal(External{Manifest: Manifest{ID: "git", APIVersion: APIVersion}}); err == nil {
		t.Fatal("the id of a built-in")
	}
	if err := r.SetExternal(External{Manifest: Manifest{ID: "x", APIVersion: APIVersion, Contributes: Contributions{Tools: []Tool{{ID: "git", Zone: "left"}}}}}); err == nil {
		t.Fatal("a tool of a built-in")
	}
	if err := r.SetExternal(External{Manifest: Manifest{ID: "greet", Name: "Greet", Version: "1.1.0", APIVersion: APIVersion}, URL: "u", Version: "1.1.0"}); err != nil {
		t.Fatal(err)
	}
	states := r.ResolveChoices(Choices{External: map[string]string{"greet": "u", "other": "v"}})
	if len(states) != 3 || states[1].Manifest.ID != "greet" || !states[1].Enabled || states[1].Disabled || !states[1].External.Installed {
		t.Fatalf("states: %+v", states)
	}
	if states[2].Manifest.ID != "other" || states[2].Enabled || states[2].External.Installed || states[2].External.URL != "v" {
		t.Fatalf("not installed: %+v", states[2])
	}
	if r.ResolveChoices(Choices{})[1].Enabled {
		t.Fatal("not used by the project: off")
	}
	// An external plugin whose requirement is missing provides nothing.
	r.RemoveExternal("greet")
	_ = r.SetExternal(External{Manifest: Manifest{ID: "greet", APIVersion: APIVersion, Provides: []string{"tickets"}, Requires: []string{"nope"}}, Version: "1.1.0"})
	states = r.ResolveChoices(Choices{External: map[string]string{"greet": "u"}})
	if Provided(states)["tickets"] || states[1].Enabled || states[1].Missing[0] != "nope" {
		t.Fatalf("capabilities of an external: %+v", states[1])
	}
	if v := r.Versions(); v["greet"] != "1.1.0" || v["git"] != "1.0.0" {
		t.Fatal(v)
	}
	r.RemoveExternal("greet")
	if len(r.Externals()) != 0 || !r.ResolveChoices(Choices{})[0].Enabled {
		t.Fatal("removed")
	}
}

// What an external plugin provides is given to the others (#155): a chain of them on together,
// off with the first.
func TestExternalProviders(t *testing.T) {
	r := NewRegistry()
	for _, m := range []Manifest{
		{ID: "alpha", Provides: []string{"greeting"}},
		{ID: "beta", Provides: []string{"echo"}, Requires: []string{"greeting"}},
		{ID: "gamma", Requires: []string{"echo"}},
	} {
		m.APIVersion = APIVersion
		if err := r.SetExternal(External{Manifest: m, Version: "1.0.0"}); err != nil {
			t.Fatal(err)
		}
	}
	all := map[string]string{"alpha": "a", "beta": "b", "gamma": "c"}
	states := r.ResolveChoices(Choices{External: all})
	if on := Enabled(states); !on["alpha"] || !on["beta"] || !on["gamma"] || Provider(states, "echo") != "beta" || !Provided(states)["greeting"] {
		t.Fatalf("a chain of externals: %+v", states)
	}
	delete(all, "alpha")
	states = r.ResolveChoices(Choices{External: all})
	if on := Enabled(states); on["beta"] || on["gamma"] || Provider(states, "greeting") != "" || states[1].Missing[0] != "greeting" || states[2].Missing[0] != "echo" {
		t.Fatalf("off with its provider: %+v", states)
	}
}

// An official plugin is used by every project unless disabled on it, as a built-in.
func TestOfficialExternal(t *testing.T) {
	r := NewRegistry()
	if err := r.SetExternal(External{Manifest: Manifest{ID: "database", Name: "Database", APIVersion: APIVersion}, URL: "u", Version: "1.0.0", Official: true}); err != nil {
		t.Fatal(err)
	}
	s := r.ResolveChoices(Choices{})[0]
	if !s.Enabled || s.Disabled || !s.External.Official {
		t.Fatalf("on by default: %+v", s)
	}
	if s := r.ResolveChoices(Choices{Disabled: []string{"database"}})[0]; s.Enabled || !s.Disabled {
		t.Fatalf("disabled on the project: %+v", s)
	}
}

// The view side of #151: an editor in a tab, settings, actions and their tools.
func TestViewBricks(t *testing.T) {
	base := func() Manifest {
		return Manifest{ID: "db-x", Name: "DB", APIVersion: APIVersion, Contributes: Contributions{
			TabViews: []TabView{{ID: "sql", Label: "SQL", Editor: &TabEditor{Lang: "sql", Keys: map[string]string{"Ctrl+Enter": "run"}}}},
			Settings: &SettingsSchema{Properties: map[string]Setting{"rows": {Type: "number", Title: "Rows", Default: 100.0}}},
			Actions:  []Action{{ID: "query", Label: "Query", Description: "Runs a query", Properties: map[string]any{"conn": map[string]any{"type": "string"}}, Access: "write", Target: "conn"}},
		}}
	}
	m := base()
	if err := m.Check(); err != nil {
		t.Fatal(err)
	}
	if got := m.ToolNames(); len(got) != 1 || got[0] != "db_x_query" {
		t.Fatalf("tools: %v", got)
	}
	bad := []func(m *Manifest){
		func(m *Manifest) { m.Contributes.TabViews[0].Editor.Lang = "SQL!" },
		func(m *Manifest) { m.Contributes.TabViews[0].Editor.Keys = map[string]string{"ctrl+enter": "run"} },
		func(m *Manifest) { m.Contributes.Settings.Properties["x"] = Setting{Type: "object"} },
		func(m *Manifest) { m.Contributes.Actions[0].Access = "admin" },
		func(m *Manifest) { m.Contributes.Actions[0].Target = "nope" },
		func(m *Manifest) { m.Contributes.Actions[0].Description = "" },
		func(m *Manifest) { m.Contributes.AssistantTools = []string{"db_x_query"} },
	}
	for i, f := range bad {
		m := base()
		f(&m)
		if err := m.Check(); err == nil {
			t.Fatalf("bad %d accepted", i)
		}
	}
}

// A language pack: its programs and folders are asked in its permissions.
func TestLanguagePackManifest(t *testing.T) {
	base := func() Manifest {
		return Manifest{ID: "lang-go", Name: "Go", APIVersion: APIVersion, Permissions: []string{"program:gopls", "path:GOMODCACHE"},
			Contributes: Contributions{Languages: []Language{{ID: "go", Name: "Go", Extensions: []string{".go"}, Grammar: "grammars/go.json",
				Servers: []LanguageServer{{Argv: []string{"gopls"}, Paths: []PathGrant{{Name: "GOMODCACHE", Candidates: []string{"$GOMODCACHE"}}}, PathDirs: []string{"GOMODCACHE/bin"}}}}}}}
	}
	m := base()
	if err := m.Check(); err != nil {
		t.Fatal(err)
	}
	bad := []func(m *Manifest){
		func(m *Manifest) { m.Permissions = []string{"path:GOMODCACHE"} },
		func(m *Manifest) { m.Permissions = []string{"program:gopls"} },
		func(m *Manifest) { m.Contributes.Languages[0].Servers[0].Argv = []string{"/bin/sh", "-c", "x"} },
		func(m *Manifest) { m.Contributes.Languages[0].Servers[0].Argv = []string{"sh -c"} },
		func(m *Manifest) { m.Contributes.Languages[0].Grammar = "../../etc/passwd.json" },
		func(m *Manifest) { m.Contributes.Languages[0].Extensions = []string{"go"} },
		func(m *Manifest) { m.Contributes.Languages[0].Servers[0].PathDirs = []string{"GOROOT/bin"} },
		func(m *Manifest) { m.Contributes.Languages[0].Servers[0].Paths[0].Access = "exec" },
	}
	for i, f := range bad {
		m := base()
		f(&m)
		if err := m.Check(); err == nil {
			t.Fatalf("bad %d accepted", i)
		}
	}
}

// A pack's debug adapters: the grant debugger:<type>, a bare program, a valid request, {port}
// only for a tcp adapter (#188).
func TestDebuggerManifest(t *testing.T) {
	base := func() Manifest {
		return Manifest{ID: "lang-go", Name: "Go", APIVersion: APIVersion, Permissions: []string{"program:gopls", "debugger:go", "path:GOROOT"},
			Contributes: Contributions{
				Languages: []Language{{ID: "go", Name: "Go", Extensions: []string{".go"}}},
				Debuggers: []Debugger{{Type: "go", Label: "Go (Delve)", Languages: []string{"go"},
					Argv: []string{"dlv", "dap", "--listen", "127.0.0.1:{port}"}, Transport: "tcp",
					Paths: []PathGrant{{Name: "GOROOT", Candidates: []string{"$GOROOT"}}}, PathDirs: []string{"GOROOT/bin"}, Install: &ServerInstall{Manager: "go", Packages: []string{"github.com/go-delve/delve/cmd/dlv@latest"}},
					Templates: []DebuggerTemplate{{Label: "Launch the package", Request: "launch", Config: json.RawMessage(`{"program":"${workspaceFolder}"}`)}}}}}}
	}
	m := base()
	if err := m.Check(); err != nil {
		t.Fatal(err)
	}
	bad := []func(m *Manifest){
		func(m *Manifest) { m.Permissions = []string{"program:gopls", "path:GOROOT"} },          // no debugger:go
		func(m *Manifest) { m.Contributes.Debuggers[0].Argv = []string{"/usr/bin/dlv", "dap"} }, // not a bare name
		func(m *Manifest) { m.Contributes.Debuggers[0].Label = "" },
		func(m *Manifest) { m.Contributes.Debuggers[0].Templates[0].Request = "run" },
		func(m *Manifest) {
			m.Contributes.Debuggers[0].Transport = "stdio"
			m.Contributes.Debuggers[0].Argv = []string{"dlv", "dap", "{port}"}
		},
		func(m *Manifest) { m.Contributes.Debuggers[0].PathDirs = []string{"GOMODCACHE/bin"} },
		func(m *Manifest) { m.Contributes.Debuggers[0].Type = "Go" },
		func(m *Manifest) {
			m.Contributes.Debuggers = append(m.Contributes.Debuggers, m.Contributes.Debuggers[0])
		},
	}
	for i, f := range bad {
		m := base()
		f(&m)
		if err := m.Check(); err == nil {
			t.Fatalf("bad %d accepted", i)
		}
	}
}
