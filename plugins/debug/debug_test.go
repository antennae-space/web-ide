package debug

import (
	"encoding/json"
	"os"
	"path"
	"testing"

	"antennae.space/ide/pod/fsx"
	"antennae.space/ide/pod/runtime"
)

// A local runtime over a temporary folder (the files of a project, without the pod).
func testRuntime(t *testing.T) *runtime.Runtime {
	t.Helper()
	dir := t.TempDir()
	return &runtime.Runtime{Root: dir, IdeDir: path.Join(dir, ".ide"), Local: true, FS: fsx.Local{}}
}

// The variables of a configuration: ${workspaceFolder}, ${file}, ${fileDirname}, ${env:NAME}.
func TestSubstitute(t *testing.T) {
	t.Setenv("DEBUG_PORT", "2345")
	vars := map[string]string{"workspaceFolder": "/p/worktree", "file": "/p/worktree/src/main.go", "fileDirname": "/p/worktree/src"}
	got := substitute(map[string]any{
		"program": "${workspaceFolder}",
		"cwd":     "${workspaceFolder}/src",
		"args":    []any{"${file}", "${env:DEBUG_PORT}"},
		"env":     map[string]any{"HOME": "${fileDirname}"},
		"port":    "${env:DEBUG_PORT}",
		"plain":   "no variable",
	}, vars)
	m := got.(map[string]any)
	if m["program"] != "/p/worktree" || m["cwd"] != "/p/worktree/src" || m["plain"] != "no variable" {
		t.Fatalf("workspaceFolder / fileDirname: %v", m)
	}
	args := m["args"].([]any)
	if args[0] != "/p/worktree/src/main.go" || args[1] != "2345" {
		t.Fatalf("args: %v", args)
	}
	if m["env"].(map[string]any)["HOME"] != "/p/worktree/src" {
		t.Fatalf("env: %v", m["env"])
	}
	if n, ok := m["port"].(float64); !ok || n != 2345 {
		t.Fatalf("a whole variable keeps its type (a port is a number): %v", m["port"])
	}
}

// .ide/debug.json: the configurations of the main project, the fields of the adapter passed
// through.
func TestConfigs(t *testing.T) {
	rt := testRuntime(t)
	if err := rt.FS.Mkdir(rt.IdeDir); err != nil {
		t.Fatal(err)
	}
	data := `{"configurations":[{"name":"Launch the package","type":"go","request":"launch","program":"${workspaceFolder}"},` +
		`{"name":"Attach","type":"go","request":"attach","processId":"${env:PID}"},{"name":"broken"}]}`
	if err := rt.FS.Write(path.Join(rt.IdeDir, "debug.json"), []byte(data)); err != nil {
		t.Fatal(err)
	}
	list, err := readConfigs(rt)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("configurations: %d", len(list))
	}
	if list[0].Name != "Launch the package" || list[0].Type != "go" || list[0].Request != "launch" || list[0].Fields["program"] != "${workspaceFolder}" {
		t.Fatalf("first: %+v", list[0])
	}
	if list[1].Request != "attach" {
		t.Fatalf("attach: %+v", list[1])
	}
	if err := saveConfigs(rt, []map[string]any{{"name": "One", "type": "go", "request": "launch"}}); err != nil {
		t.Fatal(err)
	}
	again, err := readConfigs(rt)
	if err != nil || len(again) != 1 || again[0].Name != "One" {
		t.Fatalf("saved: %+v %v", again, err)
	}
	// No file at all: no configuration, no error.
	empty := testRuntime(t)
	if list, err := readConfigs(empty); err != nil || len(list) != 0 {
		t.Fatalf("no file: %v %v", list, err)
	}
}

// .ide/breakpoints.json of a worktree: saved, read back, the lines in order.
func TestBreakpointStore(t *testing.T) {
	rt := testRuntime(t)
	s := newBreakpoints(rt)
	list, err := s.set("main.go", []Breakpoint{{Line: 30, Enabled: true}, {Line: 12, Condition: "n == 3", Enabled: true}, {Line: 20, LogMessage: "here", Enabled: false}})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[0].Line != 12 || list[2].Line != 30 {
		t.Fatalf("sorted: %+v", list)
	}
	data, err := rt.FS.Read(path.Join(rt.Root, ".ide", "breakpoints.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file Breakpoints
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Files["main.go"]) != 3 || file.Files["main.go"][0].Condition != "n == 3" {
		t.Fatalf("file: %s", data)
	}
	// Read again by a store made later (the pod restarted).
	all := newBreakpoints(rt).all()
	if len(all["main.go"]) != 3 {
		t.Fatalf("read back: %+v", all)
	}
	if _, err := s.set("main.go", nil); err != nil {
		t.Fatal(err)
	}
	if len(s.all()) != 0 {
		t.Fatalf("an empty list takes the file out: %+v", s.all())
	}
	if _, err := os.Stat(path.Join(rt.Root, ".ide", "breakpoints.json")); err != nil {
		t.Fatal(err)
	}
}

// The breakpoints as DAP takes them: a condition, a hit count, a log message.
func TestDAPBreakpoints(t *testing.T) {
	got := dapBreakpoints([]Breakpoint{{Line: 12, Condition: "n == 3", HitCondition: "5", LogMessage: "here", Enabled: true}})
	if len(got) != 1 {
		t.Fatalf("%+v", got)
	}
	m := got[0]
	if m["line"] != 12 || m["condition"] != "n == 3" || m["hitCondition"] != "5" || m["logMessage"] != "here" {
		t.Fatalf("dap: %+v", m)
	}
}

// {port} is replaced in an adapter's arguments (dlv dap --listen 127.0.0.1:{port}).
func TestFillPort(t *testing.T) {
	got := fillPort([]string{"dlv", "dap", "--listen", "127.0.0.1:{port}"}, 4321)
	if got[3] != "127.0.0.1:4321" || got[0] != "dlv" {
		t.Fatalf("%v", got)
	}
}
