package install

import (
	"os"
	"path/filepath"
	"testing"

	"antennae.space/ide/pod/plugins"
)

func TestResolvePath(t *testing.T) {
	home := t.TempDir()
	gopath := filepath.Join(home, "gopath")
	_ = os.MkdirAll(filepath.Join(gopath, "pkg", "mod"), 0o755)
	_ = os.MkdirAll(filepath.Join(home, "go", "pkg", "mod"), 0o755)
	_ = os.MkdirAll(filepath.Join(home, ".ssh"), 0o700)
	env := map[string]string{"GOPATH": gopath + ":/other"}
	h := Host{Env: func(k string) string { return env[k] }, Home: home, Data: filepath.Join(home, ".web-ide")}
	g := plugins.PathGrant{Name: "GOMODCACHE", Candidates: []string{"$GOMODCACHE", "$GOPATH/pkg/mod", "~/go/pkg/mod"}}
	if p, err := h.ResolvePath(g); err != nil || p != filepath.Join(gopath, "pkg", "mod") {
		t.Fatalf("the first that exists ($GOMODCACHE unset): %q %v", p, err)
	}
	delete(env, "GOPATH")
	if p, _ := h.ResolvePath(g); p != filepath.Join(home, "go", "pkg", "mod") {
		t.Fatalf("~: %q", p)
	}
	for _, bad := range []string{"~", "~/.ssh", "~/.web-ide", "/"} {
		_ = os.MkdirAll(h.expand(bad), 0o755)
		if p, err := h.ResolvePath(plugins.PathGrant{Name: "X", Candidates: []string{bad}}); err == nil {
			t.Fatalf("%s given: %s", bad, p)
		}
	}
	if _, err := h.ResolvePath(plugins.PathGrant{Name: "X", Candidates: []string{"$NOPE", "~/missing"}}); err == nil {
		t.Fatal("nothing found")
	}
}

// @program: the folder of a program found on the PATH (its real path), not run.
func TestResolveFromProgram(t *testing.T) {
	root := t.TempDir()
	goroot := filepath.Join(root, "sdk", "go1.27")
	_ = os.MkdirAll(filepath.Join(goroot, "bin"), 0o755)
	_ = os.WriteFile(filepath.Join(goroot, "bin", "go"), []byte("#!/bin/sh\nexit 1\n"), 0o755)
	links := filepath.Join(root, "bin")
	_ = os.MkdirAll(links, 0o755)
	_ = os.Symlink(filepath.Join(goroot, "bin", "go"), filepath.Join(links, "go"))
	h := Host{Env: func(k string) string { return map[string]string{"PATH": links}[k] }, Home: filepath.Join(root, "home")}
	if p, err := h.ResolvePath(plugins.PathGrant{Name: "GOROOT", Candidates: []string{"$GOROOT", "@go/../.."}}); err != nil || p != goroot {
		t.Fatalf("GOROOT from the go of the PATH: %q %v", p, err)
	}
}

func TestResolveProgram(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "gopls"), []byte("#!/bin/sh\n"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "plain"), []byte(""), 0o644)
	h := Host{Env: func(k string) string { return map[string]string{"PATH": "relative:" + dir}[k] }}
	if p, err := h.ResolveProgram("gopls"); err != nil || p != filepath.Join(dir, "gopls") {
		t.Fatalf("%q %v", p, err)
	}
	if _, err := h.ResolveProgram("plain"); err == nil {
		t.Fatal("not executable")
	}
}
