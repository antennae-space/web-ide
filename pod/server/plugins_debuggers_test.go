package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/runtime"
)

// An adapter runs on its grant debugger:<type>, unconfined (no plugin-exec), on this machine or
// on the host of an SSH project, with the folders and variables of the pack on its PATH (#188).
func TestDebuggerCommand(t *testing.T) {
	s, _ := newServer(t)
	bin, root := t.TempDir(), t.TempDir()
	_ = os.WriteFile(filepath.Join(bin, "dlv"), []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	t.Setenv("TOYROOT", root)
	d := plugins.Debugger{Type: "go", Label: "Go (Delve)", Argv: []string{"dlv", "dap", "--listen", "127.0.0.1:{port}"},
		Transport: "tcp", Paths: []plugins.PathGrant{{Name: "TOYROOT", Candidates: []string{"$TOYROOT"}, Env: true}},
		PathDirs: []string{"TOYROOT/bin"}, Env: map[string]string{"GOTOOLCHAIN": "local"}}
	m := plugins.Manifest{ID: "lang-toy", Name: "Toy", Version: "1.0.0", APIVersion: plugins.APIVersion,
		Permissions: []string{"debugger:go", "path:TOYROOT"}, Contributes: plugins.Contributions{Debuggers: []plugins.Debugger{d}}}
	grant := func(g ...string) {
		if err := s.Plugins.SetExternal(plugins.External{Manifest: m, URL: "u", Version: "1.0.0", Grants: g}); err != nil {
			t.Fatal(err)
		}
	}
	grant("path:TOYROOT")
	local := &runtime.Runtime{Root: t.TempDir(), Local: true}
	if _, err := s.debuggerCommand(local, "lang-toy", d); err == nil || !strings.Contains(err.Error(), "debugger:go is not granted") {
		t.Fatalf("without its grant: %v", err)
	}
	grant("debugger:go")
	if _, err := s.debuggerCommand(local, "lang-toy", d); err == nil || !strings.Contains(err.Error(), "path:TOYROOT is not granted") {
		t.Fatalf("a folder not granted: %v", err)
	}
	grant("debugger:go", "path:TOYROOT")
	argv, err := s.debuggerCommand(local, "lang-toy", d)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(argv, " ")
	for _, want := range []string{"sh -c", "PATH='" + filepath.Join(root, "bin") + ":$PATH'", "TOYROOT=" + root, "GOTOOLCHAIN=local", `exec "$0" "$@"`, "dlv dap --listen"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in %s", want, joined)
		}
	}
	if strings.Contains(joined, "plugin-exec") {
		t.Fatalf("an adapter is not confined: %s", joined)
	}
	host := &shellHost{found: "/usr/bin/dlv"}
	remote := &runtime.Runtime{Root: "/srv/p", Local: false, Runner: host}
	argv, err = s.debuggerCommand(remote, "lang-toy", d)
	if err != nil {
		t.Fatal(err)
	}
	joined = strings.Join(argv, " ")
	if !strings.Contains(joined, "web-ide/tools/lang-toy") || !strings.Contains(joined, "dlv dap --listen") || strings.Contains(joined, "plugin-exec") {
		t.Fatalf("on the SSH host, the pack's tools first on its PATH: %s", joined)
	}
	host.found = ""
	if _, err := s.debuggerCommand(remote, "lang-toy", d); err == nil {
		t.Fatal("a program missing on the host")
	}
}
