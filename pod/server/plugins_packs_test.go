package server

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/plugins/confine"
	"antennae.space/ide/pod/runtime"
)

func TestPackCommand(t *testing.T) {
	s, _ := newServer(t)
	bin, lib := t.TempDir(), t.TempDir()
	_ = os.WriteFile(filepath.Join(bin, "toy-lsp"), []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	t.Setenv("TOYLIB", lib)
	sv := plugins.LanguageServer{Argv: []string{"toy-lsp", "--stdio"}, Paths: []plugins.PathGrant{{Name: "TOYLIB", Candidates: []string{"$TOYLIB"}, Env: true, Access: "write"}}, PathDirs: []string{"TOYLIB/bin"}}
	m := plugins.Manifest{ID: "lang-toy", Name: "Toy", Version: "1.0.0", APIVersion: plugins.APIVersion, Permissions: []string{"program:toy-lsp", "path:TOYLIB"},
		Contributes: plugins.Contributions{Languages: []plugins.Language{{ID: "toy", Name: "Toy", Extensions: []string{".toy"}, Servers: []plugins.LanguageServer{sv}}}}}
	if err := s.Plugins.SetExternal(plugins.External{Manifest: m, URL: "u", Version: "1.0.0", Grants: []string{"program:toy-lsp"}}); err != nil {
		t.Fatal(err)
	}
	remote := &runtime.Runtime{Root: "/srv/p", Local: false}
	if argv, err := s.packCommand(remote, "lang-toy", sv); err != nil || strings.Join(argv, " ") != "toy-lsp --stdio" {
		t.Fatalf("on the SSH host: the bare program: %v %v", argv, err)
	}
	local := &runtime.Runtime{Root: t.TempDir(), Local: true}
	if confine.ABI() < 1 {
		t.Skip("no Landlock")
	}
	if _, err := s.packCommand(local, "lang-toy", sv); err == nil || !strings.Contains(err.Error(), "path:TOYLIB is not granted") {
		t.Fatalf("a folder not granted: %v", err)
	}
	_ = s.Plugins.SetExternal(plugins.External{Manifest: m, URL: "u", Version: "1.0.0", Grants: []string{"program:toy-lsp", "path:TOYLIB"}})
	argv, err := s.packCommand(local, "lang-toy", sv)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(argv, " ")
	for _, want := range []string{"/usr/bin/env -i", "TOYLIB=" + lib, "PATH=" + filepath.Join(lib, "bin") + ":", "plugin-exec", "-project " + local.Root, "-read " + filepath.Join(bin, "toy-lsp"), "-writedir " + lib, "-- " + filepath.Join(bin, "toy-lsp") + " --stdio"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in %s", want, joined)
		}
	}
	if slices.Contains(argv, "-net") || slices.Contains(argv, "-write") {
		t.Fatalf("no network, the project read only: %s", joined)
	}
	_ = s.Plugins.SetExternal(plugins.External{Manifest: m, URL: "u", Version: "1.0.0", Grants: []string{"path:TOYLIB"}})
	if _, err := s.packCommand(remote, "lang-toy", sv); err == nil {
		t.Fatal("a program not granted runs nowhere")
	}
}
