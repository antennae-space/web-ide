package ai

import (
	"context"
	"testing"
	"time"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/pod/console"
	"antennae.space/ide/pod/execx"
	"antennae.space/ide/pod/runtime"
)

// The consoles a conversation started: kept in the conversation, listed while they run,
// dropped once they ended.

func testRuntime(t *testing.T, dir string) *runtime.Runtime {
	t.Helper()
	return &runtime.Runtime{Root: dir, Local: true, Runner: execx.Local{},
		Consoles: console.NewManager(execx.Local{}, dir, console.Events{Output: func(string, []byte, int64) {}, Exit: func(string, int) {}})}
}

func TestShellsOfAConversation(t *testing.T) {
	dir := t.TempDir()
	s, project := newTestA(t, dir)
	rt := testRuntime(t, dir)
	s.host.Pod().(*fakePod).setRuntime(project, rt)
	cc, err := s.chatLocOf(project)
	if err != nil {
		t.Fatal(err)
	}

	r := &assistantRun{id: "chat1", loc: cc.loc, root: project, project: project,
		chat: &engine.Chat{ID: "chat1"}, ctx: context.Background(), state: "running"}
	info, err := rt.Consoles.Create("task", "sleep", []string{"sh", "-c", "sleep 30"}, dir, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	s.trackShell(r, rt, info.ID)
	if got := r.chat.Consoles; len(got) != 1 || got[0] != info.ID {
		t.Fatalf("the conversation keeps the console it started: %v", got)
	}
	shells := runningShells(r.chat, rt)
	if len(shells) != 1 || shells[0].ID != info.ID || shells[0].Title != "sleep" {
		t.Fatalf("the running console is listed: %+v", shells)
	}

	// Ended: dropped from the conversation, and the shells are empty.
	if err := rt.Consoles.Close(info.ID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(runningShells(r.chat, rt)) == 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := runningShells(r.chat, rt); len(got) != 0 {
		t.Fatalf("the ended console is no longer a shell: %+v", got)
	}
	shells, err = s.pruneShells(cc, project, r.id)
	if err != nil {
		t.Fatal(err)
	}
	if len(shells) != 0 {
		t.Fatalf("pruneShells: %+v", shells)
	}
	stored, err := s.loadChat(cc.loc, r.id)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.Consoles) != 0 {
		t.Fatalf("the conversation forgot the console: %v", stored.Consoles)
	}
}

func TestShellsOfAConversationWithSeveral(t *testing.T) {
	dir := t.TempDir()
	s, project := newTestA(t, dir)
	rt := testRuntime(t, dir)
	s.host.Pod().(*fakePod).setRuntime(project, rt)
	cc, err := s.chatLocOf(project)
	if err != nil {
		t.Fatal(err)
	}
	r := &assistantRun{id: "chat2", loc: cc.loc, root: project, project: project,
		chat: &engine.Chat{ID: "chat2"}, ctx: context.Background(), state: "running"}

	quick, err := rt.Consoles.Create("task", "quick", []string{"sh", "-c", "exit 0"}, dir, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	slow, err := rt.Consoles.Create("task", "slow", []string{"sh", "-c", "sleep 30"}, dir, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	s.trackShell(r, rt, quick.ID)
	s.trackShell(r, rt, slow.ID)
	s.trackShell(r, rt, "") // nothing started: nothing recorded

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if n := len(runningShells(r.chat, rt)); n == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	shells := runningShells(r.chat, rt)
	if len(shells) != 1 || shells[0].ID != slow.ID {
		t.Fatalf("only the console still running is a shell: %+v", shells)
	}
	if err := rt.Consoles.Close(slow.ID); err != nil {
		t.Fatal(err)
	}
}
