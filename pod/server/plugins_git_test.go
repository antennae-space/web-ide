package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"antennae.space/ide/pod/sshx"
)

// What git refuses a plugin (#157): another program, another folder, a setting.
func TestCheckGitArgs(t *testing.T) {
	for _, ok := range [][]string{
		{"-c", "core.quotepath=off", "-c", "color.ui=false", "status", "--porcelain"},
		{"worktree", "add", "-b", "ticket/1", ".ide/worktrees/1", "main"},
		{"config", "--get", "remote.origin.url"},
		{"push", "origin", "ticket/1"},
	} {
		if err := checkGitArgs(ok); err != nil {
			t.Errorf("%v: %v", ok, err)
		}
	}
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"-c", "core.pager=sh", "log"}, "core.pager"},
		{[]string{"-c", "core.sshCommand=x", "fetch"}, "core.sshCommand"},
		{[]string{"-C", "/etc", "status"}, "-C"},
		{[]string{"--git-dir=/x", "status"}, "--git-dir"},
		{[]string{"fetch", "--upload-pack=sh"}, "--upload-pack"},
		{[]string{"diff", "--ext-diff"}, "--ext-diff"},
		{[]string{"fetch", "ext::sh -c x"}, "ext::"},
		{[]string{"config", "core.hooksPath", "/tmp"}, "--get"},
		{[]string{"filter-branch"}, "filter-branch"},
		{nil, "no command"},
	} {
		if err := checkGitArgs(c.args); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: %v, want %q", c.args, err, c.want)
		}
	}
}

// The folders of a plugin's git: the project and its worktrees, not .ide nor outside.
func TestPluginGitDirs(t *testing.T) {
	s, ts := newServer(t)
	a, _ := dial(t, ts, s.Token)
	root := t.TempDir()
	id := a.call("projects.create", map[string]any{"type": "local", "path": root})["result"].(map[string]any)["id"].(string)
	rt, _ := s.openRuntime(id, sshx.Creds{})
	for dir, ok := range map[string]bool{"": true, "src": true, ".ide/worktrees/1-x": true, root + "/.ide/worktrees/2": true,
		".ide": false, ".ide/kanban.db": false, "..": false, "/etc": false, root + "/../other": false} {
		if _, _, err := s.projectDir(rt, dir); (err == nil) != ok {
			t.Errorf("%q: %v", dir, err)
		}
	}
	e := ext("alpha", "worktrees")
	if _, err := s.pluginWorktree(context.Background(), rt, e, "worktree.register", json.RawMessage(`{"owner":1,"title":"t","path":"src"}`)); err == nil {
		t.Fatal("a worktree project out of .ide/worktrees")
	}
	if r, err := s.pluginWorktree(context.Background(), rt, e, "worktree.register", json.RawMessage(`{"owner":7,"title":"#7","path":".ide/worktrees/7-x"}`)); err != nil || r.(map[string]any)["project"] != id+"-t7" {
		t.Fatalf("registered: %v %v", r, err)
	}
	if _, err := s.pluginWorktree(context.Background(), rt, e, "worktree.unregister", json.RawMessage(`{"owner":7}`)); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Projects.Get(id + "-t7"); ok {
		t.Fatal("unregistered")
	}
	if _, err := s.pluginWorktree(context.Background(), rt, ext("alpha"), "ide.keepOut", nil); err == nil || !strings.Contains(err.Error(), "worktrees is not granted") {
		t.Fatalf("no grant: %v", err)
	}
}
