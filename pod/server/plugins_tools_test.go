package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"antennae.space/ide/pod/plugins"
)

// The recipes of the servers: one shell line into the pack's folder of tools, words quoted.
func TestInstallCommand(t *testing.T) {
	npm := installCommand("lang-ts", plugins.ServerInstall{Manager: "npm", Packages: []string{"typescript-language-server", "typescript@5"}})
	if !strings.Contains(npm, `"${XDG_DATA_HOME:-$HOME/.local/share}/web-ide/tools/lang-ts"`) || !strings.HasSuffix(npm, `npm install -g --prefix "$D/npm" --no-audit --no-fund typescript-language-server typescript@5`) {
		t.Fatalf("npm: %s", npm)
	}
	pip := installCommand("lang-python", plugins.ServerInstall{Manager: "pip", Packages: []string{"python-lsp-server[all]"}})
	if !strings.HasSuffix(pip, `python3 -m venv "$D/venv" && "$D/venv/bin/pip" install 'python-lsp-server[all]'`) {
		t.Fatalf("pip: %s", pip)
	}
	if g := installCommand("lang-go", plugins.ServerInstall{Manager: "go", Packages: []string{"golang.org/x/tools/gopls@latest"}}); !strings.HasSuffix(g, `GOBIN="$D/go/bin" go install golang.org/x/tools/gopls@latest`) {
		t.Fatalf("go: %s", g)
	}
}

// The servers of the packs: found in the pack's folder of tools before the PATH, or missing
// with their recipe and what is lacking to run it.
func TestPackServers(t *testing.T) {
	s, _ := newServer(t)
	data, bin := t.TempDir(), t.TempDir()
	t.Setenv("XDG_DATA_HOME", data)
	t.Setenv("PATH", bin)
	sv := plugins.LanguageServer{Argv: []string{"toy-lsp"}, Install: &plugins.ServerInstall{Manager: "npm", Packages: []string{"toy-lsp"}}}
	m := plugins.Manifest{ID: "lang-toy", Name: "Toy", Version: "1.0.0", APIVersion: plugins.APIVersion, Permissions: []string{"program:toy-lsp"},
		Contributes: plugins.Contributions{Languages: []plugins.Language{{ID: "toy", Name: "Toy", Extensions: []string{".toy"}, Servers: []plugins.LanguageServer{sv}}}}}
	if err := s.Plugins.SetExternal(plugins.External{Manifest: m, URL: "u", Version: "1.0.0", Grants: []string{"program:toy-lsp"}}); err != nil {
		t.Fatal(err)
	}
	list := podLend{s}.PackServers(nil)
	if len(list) != 1 || list[0].Path != "" || list[0].Needs != "npm" || list[0].PackName != "Toy" || !strings.Contains(list[0].Command, "npm install") {
		t.Fatalf("missing, npm lacking: %+v", list)
	}
	_ = os.WriteFile(filepath.Join(bin, "npm"), []byte("#!/bin/sh\n"), 0o755)
	tools := filepath.Join(data, "web-ide", "tools", "lang-toy", "npm", "bin")
	_ = os.MkdirAll(tools, 0o755)
	_ = os.WriteFile(filepath.Join(tools, "toy-lsp"), []byte("#!/bin/sh\n"), 0o755)
	if list := (podLend{s}).PackServers(nil); len(list) != 1 || list[0].Path != filepath.Join(tools, "toy-lsp") || list[0].Needs != "" {
		t.Fatalf("installed in its folder of tools: %+v", list)
	}
}
