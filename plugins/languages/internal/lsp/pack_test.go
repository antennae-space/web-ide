package lsp

import (
	"context"
	"errors"
	"testing"

	"antennae.space/ide/pod/execx"
	"antennae.space/ide/pod/plugins"
)

// hostRunner is a runner of an SSH host where only some programs are installed.
type hostRunner struct{ has map[string]bool }

func (r hostRunner) Start([]string, string) (execx.Process, error) { return nil, errors.New("no") }
func (r hostRunner) StartPTY([]string, string, int, int) (execx.PTY, error) {
	return nil, errors.New("no")
}
func (r hostRunner) Output(context.Context, []string, string) ([]byte, error) { return nil, nil }
func (r hostRunner) Has(name string) bool                                     { return r.has[name] }

var toy = PackSpec(plugins.PackLanguage{Pack: "lang-toy", Language: plugins.Language{ID: "toy", Name: "Toy", Extensions: []string{".toy"},
	LanguageIDs: map[string]string{".toyx": "toyreact"},
	Servers:     []plugins.LanguageServer{{Argv: []string{"toy-ls", "--stdio"}}, {Argv: []string{"toy-lsp"}}}}})

// A pack's language wins over a default, its servers started by the pod's command: the first
// whose program is on the SSH host.
func TestPackServers(t *testing.T) {
	var asked []string
	cmd := func(pack string, sv plugins.LanguageServer) ([]string, error) {
		asked = append(asked, pack+":"+sv.Argv[0])
		return append([]string{"ssh-host"}, sv.Argv...), nil
	}
	m := NewManager(hostRunner{has: map[string]bool{"toy-lsp": true}}, "/p", false, nil, func(string) bool { return false }, nil)
	m.UsePacks(func() []Spec {
		return []Spec{toy, PackSpec(plugins.PackLanguage{Pack: "lang-go", Language: plugins.Language{ID: "go", Name: "Go", Extensions: []string{".go"}}})}
	}, cmd)
	if got := m.command("toy"); len(got) != 2 || got[1] != "toy-lsp" || len(asked) != 1 || asked[0] != "lang-toy:toy-lsp" {
		t.Fatalf("command %v, asked %v", got, asked)
	}
	if s, _ := m.spec("go"); s.Pack != "lang-go" {
		t.Fatalf("the pack's go wins over the default: %+v", s)
	}
	if s, ok := m.spec("php"); !ok || s.Pack != "" {
		t.Fatal("the defaults stay")
	}
	// Nothing installed on the host: no server.
	m2 := NewManager(hostRunner{}, "/p", false, nil, func(string) bool { return false }, nil)
	m2.UsePacks(func() []Spec { return []Spec{toy} }, cmd)
	if got := m2.command("toy"); got != nil {
		t.Fatalf("no program on the host: %v", got)
	}
}

func TestPackLanguageOfFiles(t *testing.T) {
	old := Packs
	t.Cleanup(func() { Packs = old })
	Packs = func() []Spec { return []Spec{toy} }
	if LangOf("a/b.toy") != "toy" || LangOf("x.php") != "php" || LangOf("x.go") != "" || LanguageID("b.toy") != "toy" {
		t.Fatal("the pack's extension")
	}
}
