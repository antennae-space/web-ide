package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"antennae.space/ide/pod/execx"
	"antennae.space/ide/pod/runtime"
)

// remoteRunner answers Output with the command and its folder, as the host of an SSH project.
type remoteRunner struct{ execx.Runner }

func (remoteRunner) Output(_ context.Context, argv []string, dir string) ([]byte, error) {
	if argv[0] == "false" {
		return nil, errors.New("exit status 1")
	}
	return []byte(strings.Join(argv, " ") + " in " + dir), nil
}

// exec runs a granted program on the host of an SSH project, in the project, and nowhere else.
func TestPluginExec(t *testing.T) {
	s, _ := newServer(t)
	rt := &runtime.Runtime{Root: "/srv/app", Runner: remoteRunner{}}
	call := func(params string, grants ...string) (any, error) {
		return s.pluginExec(context.Background(), rt, ext("database", grants...), json.RawMessage(params))
	}
	if _, err := call(`{"argv":["sqlite3","-version"]}`); err == nil || !strings.Contains(err.Error(), "exec:sqlite3 is not granted") {
		t.Fatalf("without its grant: %v", err)
	}
	if _, err := call(`{"argv":["/usr/bin/sqlite3"]}`, "exec:sqlite3"); err == nil {
		t.Fatal("a path instead of a name")
	}
	r, err := call(`{"argv":["sqlite3","-version"],"dir":"db"}`, "exec:sqlite3")
	if err != nil || r.(map[string]any)["output"] != "sqlite3 -version in /srv/app/db" {
		t.Fatalf("on the host: %v %v", r, err)
	}
	if _, err := call(`{"argv":["sqlite3"],"dir":"/etc"}`, "exec:sqlite3"); err == nil {
		t.Fatal("a folder outside the project")
	}
	if _, err := call(`{"argv":["false"]}`, "exec:false"); err == nil {
		t.Fatal("a failure is an error")
	}
	rt.Local = true
	if _, err := call(`{"argv":["sqlite3"]}`, "exec:sqlite3"); err == nil || !strings.Contains(err.Error(), "the backend runs it itself") {
		t.Fatalf("a local project: %v", err)
	}
}
