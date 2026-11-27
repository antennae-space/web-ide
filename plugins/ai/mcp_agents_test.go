package ai

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"antennae.space/ide/plugins/ai/acp"
	"antennae.space/ide/pod/caps"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/runtime"
	"antennae.space/ide/pod/sshx"
)

// The MCP tools of a Supervisor on the sessions of the Agents tool, tested on the fake ACP
// agent of the browser tests (e2e/bin/claude-agent-acp). The Kanban answers come from the test
// pod, so the tools run their whole path: the ticket, its worktree, the provider, the model,
// the reservation of the development, and the thread.

// fakeKanban answers the methods of the Kanban the agent tools call.
type fakeKanban struct {
	tickets map[int64]kbTicket
	step    int64 // the step to develop of the lineage (kanban.worktreeTicket)
}

func (k *fakeKanban) call(project, method string, params json.RawMessage) (json.RawMessage, error) {
	switch method {
	case "kanban.get":
		var a struct {
			ID int64 `json:"id"`
		}
		if err := json.Unmarshal(params, &a); err != nil {
			return nil, err
		}
		t, ok := k.tickets[a.ID]
		if !ok {
			return nil, errors.New("ticket not found")
		}
		return json.Marshal(t)
	case "kanban.markdown":
		return json.Marshal(map[string]string{"markdown": "## Description\n\nExport the CSV."})
	case "kanban.worktreeTicket":
		return json.Marshal(map[string]int64{"id": k.step})
	}
	return nil, errors.New("no Kanban method in the tests: " + method)
}

// testAgents is the plugin on a main project at dir, with the registered worktree of ticket 1,
// a runtime for each project, the Kanban answers, and the fake agent installed as claude.
func testAgents(t *testing.T, dir string, tickets map[int64]kbTicket, step int64) (*A, string, string, string) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is needed by the fake agent")
	}
	s, main := newTestA(t, dir)
	wt := filepath.Join(dir, ".ide", "worktrees", "1-data-export")
	if err := os.MkdirAll(wt, 0o700); err != nil {
		t.Fatal(err)
	}
	parent, ok := s.Projects.Get(main)
	if !ok {
		t.Fatal("main project")
	}
	child, err := s.Projects.PutChild(parent, 1, "Data export", wt)
	if err != nil {
		t.Fatal(err)
	}
	bin, err := filepath.Abs("../../e2e/bin/claude-agent-acp")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "claude-agent-acp")
	if err := os.Symlink(bin, link); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(link)+string(os.PathListSeparator)+os.Getenv("PATH"))
	pod := s.host.Pod().(*fakePod)
	kb := &fakeKanban{tickets: tickets, step: step}
	pod.kanban = kb.call
	for _, id := range []string{main, child.ID} {
		p, ok := s.Projects.Get(id)
		if !ok {
			t.Fatalf("project %s", id)
		}
		rt, err := runtime.Open(*p, sshx.Creds{}, runtime.Deps{Store: s.Store}, func(string, any, string) {})
		if err != nil {
			t.Fatal(err)
		}
		pod.setRuntime(id, rt)
	}
	s.testAgentCommand = func(string) ([]string, error) { return []string{bin}, nil }
	return s, main, child.ID, wt
}

// agentScope is the MCP grant of a Supervisor working in the project of here.
func agentScope(t *testing.T, s *A, main, here string, allows bool) plugins.MCPScope {
	t.Helper()
	root, ok := s.Projects.Get(main)
	if !ok {
		t.Fatal("main project")
	}
	hereP, ok := s.Projects.Get(here)
	if !ok {
		t.Fatalf("project %s", here)
	}
	return plugins.MCPScope{Here: hereP, Root: root, Ticket: 1, Identity: "client:sup", Supervisor: true,
		AllowsProject: func(here, root string) bool { return allows && (here == main || root == main) }}
}

// callMCP calls one tool as a client of the MCP does.
func callMCP(t *testing.T, s *A, name string, sc plugins.MCPScope, args map[string]any) (string, error) {
	t.Helper()
	tool := s.host.(fakeHost).mcp[name]
	if tool.Run == nil {
		t.Fatalf("tool %s is not registered", name)
	}
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return tool.Run(context.Background(), sc, raw)
}

// agentsOfTest is the manager of the sessions of a project, the one the tools use.
func agentsOfTest(t *testing.T, s *A, project string) *acp.Manager {
	t.Helper()
	rt, err := s.host.Pod().(*fakePod).Runtime(project)
	if err != nil {
		t.Fatal(err)
	}
	m := s.agentsOf(rt)
	if m == nil {
		t.Fatal("no agent manager")
	}
	return m
}

// sessionID reads the session id of the answer of agent_start.
func sessionID(text string) string {
	return strings.Fields(text)[1]
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout: %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// ticket1 is the ticket of the worktree made by testAgents.
func ticket1(dir string) map[int64]kbTicket {
	return map[int64]kbTicket{1: {ID: 1, Title: "Data export", Branch: "ticket/1-data-export",
		Worktree: filepath.Join(dir, ".ide", "worktrees", "1-data-export")}}
}

// T1: agent_start runs the ticket's briefing as the first prompt, applies the model it asks
// before it, and the session shows up in agent_list, agent_read and agent_providers.
func TestAgentStartTicket(t *testing.T) {
	dir := t.TempDir()
	s, main, child, wt := testAgents(t, dir, ticket1(dir), 1)
	sc := agentScope(t, s, main, child, true)

	text, err := callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 1, "provider": "claude", "model": "sonnet"})
	if err != nil {
		t.Fatal(err)
	}
	id := sessionID(text)
	if !strings.Contains(text, "Session "+id+" of ticket #1 in "+wt) {
		t.Fatal(text)
	}
	if !strings.Contains(text, "Model sonnet, applied before the first prompt") || !strings.Contains(text, "Its first prompt is the ticket briefing") {
		t.Fatal(text)
	}

	m := agentsOfTest(t, s, child)
	sess, err := m.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session ready", func() bool { return sess.Info().State == acp.Ready })
	info := sess.Info()
	if info.Ticket != 1 || info.Model() != "sonnet" || info.Title != "#1 Data export" || info.Cwd != wt {
		t.Fatalf("%+v", info)
	}
	// The agent confirms the model before the first prompt is sent.
	if info.Config == nil {
		t.Fatalf("no config options: %+v", info)
	}
	// The briefing, then the answer of the agent.
	text, err = callMCP(t, s, "agent_read", sc, map[string]any{"cwd": wt, "session": id})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "Session "+id+" (Claude Code, ready), model sonnet, ticket #1") {
		t.Fatal(text)
	}
	if !strings.Contains(text, "Briefing received (ticket #1). MCP none: no MCP server") {
		t.Fatal(text)
	}

	text, err = callMCP(t, s, "agent_list", sc, map[string]any{"cwd": wt, "ticket": 1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "id "+id) || !strings.Contains(text, "model sonnet") || !strings.Contains(text, "ticket #1") || !strings.Contains(text, "1 turns") {
		t.Fatal(text)
	}

	text, err = callMCP(t, s, "agent_providers", sc, map[string]any{"cwd": wt})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "- claude (Claude Code): installed, models: sonnet") {
		t.Fatal(text)
	}
}

// T2: a model the provider does not offer ends the session with its error; the reservation is
// released, so a retry with a valid model opens a new session.
func TestAgentModelRejected(t *testing.T) {
	dir := t.TempDir()
	s, main, child, wt := testAgents(t, dir, ticket1(dir), 1)
	sc := agentScope(t, s, main, child, true)

	text, err := callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 1, "provider": "claude", "model": "haiku"})
	if err != nil {
		t.Fatal(err)
	}
	id := sessionID(text)
	m := agentsOfTest(t, s, child)
	sess, err := m.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session failed", func() bool { return sess.Info().State == acp.Failed })
	want := `model "haiku" is not available for Claude Code: opus | sonnet`
	if !strings.Contains(sess.Info().Error, want) {
		t.Fatal(sess.Info().Error)
	}

	text, err = callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 1, "provider": "claude", "model": "opus"})
	if err != nil {
		t.Fatal(err)
	}
	if sessionID(text) == id {
		t.Fatal("the retry reused the failed session: " + text)
	}
	if !strings.Contains(text, "Its first prompt is the ticket briefing") {
		t.Fatal(text)
	}
	second, err := m.Get(sessionID(text))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "retry ready", func() bool { return second.Info().State == acp.Ready })
	if second.Info().Model() != "opus" {
		t.Fatalf("%+v", second.Info())
	}

	text, err = callMCP(t, s, "agent_list", sc, map[string]any{"cwd": wt})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "error: "+want) {
		t.Fatal(text)
	}
}

// T3: one development per ticket. The reservation taken by a session is shared with the Kanban
// UI path, and the idle session of the ticket is reused by a later agent_start.
func TestAgentOneDevelopmentPerTicket(t *testing.T) {
	dir := t.TempDir()
	tickets := ticket1(dir)
	s, main, child, wt := testAgents(t, dir, tickets, 1)
	sc := agentScope(t, s, main, child, true)

	text, err := callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 1, "provider": "claude", "model": "opus"})
	if err != nil {
		t.Fatal(err)
	}
	id := sessionID(text)
	m := agentsOfTest(t, s, child)
	sess, err := m.Get(id)
	if err != nil {
		t.Fatal(err)
	}

	// While its turn runs, a second start of the same ticket is refused.
	_, err = callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 1, "provider": "claude", "model": "opus"})
	if err == nil || !strings.Contains(err.Error(), "active development (session "+id) {
		t.Fatalf("second start: %v", err)
	}
	// The Kanban UI path shares the reservation.
	brief := caps.TicketBrief{ID: 1, Role: "dev", Title: "Data export", Branch: "ticket/1-data-export", Model: "opus"}
	if _, _, err := (agentsCap{s}).Develop(child, "claude", brief); err == nil ||
		!strings.Contains(err.Error(), "active development (session "+id) {
		t.Fatalf("UI path: %v", err)
	}

	waitFor(t, "session ready", func() bool { return sess.Info().State == acp.Ready })
	text, err = callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 1, "provider": "claude", "model": "opus", "message": "one more change"})
	if err != nil {
		t.Fatal(err)
	}
	if sessionID(text) != id || !strings.Contains(text, "Its prompt is sent now.") {
		t.Fatal(text)
	}
	if len(m.List()) != 1 {
		t.Fatalf("%d sessions", len(m.List()))
	}

	// The Kanban UI path first: the reservation it takes is shared with the MCP tools, so the
	// start of the same ticket through MCP is refused.
	tickets[3] = kbTicket{ID: 3, Title: "Rows", Parent: 1, Branch: "ticket/1-data-export"}
	s.host.Pod().(*fakePod).kanban = func(project, method string, params json.RawMessage) (json.RawMessage, error) {
		kb := &fakeKanban{tickets: tickets, step: 3}
		return kb.call(project, method, params)
	}
	brief3 := caps.TicketBrief{ID: 3, Parent: 1, Role: "dev", Title: "Rows", Branch: "ticket/1-data-export"}
	sess3, created, err := (agentsCap{s}).Develop(child, "claude", brief3)
	if err != nil || !created {
		t.Fatalf("UI start: %v (%+v)", err, sess3)
	}
	_, err = callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 3, "provider": "claude"})
	if err == nil || !strings.Contains(err.Error(), "active development (session "+sess3.ID) {
		t.Fatalf("MCP after the UI path: %v", err)
	}
}

// T4: a step of a lineage runs in the worktree of its root; the tools refuse the ticket that
// is not the step to develop.
func TestAgentLineageStep(t *testing.T) {
	dir := t.TempDir()
	wt := filepath.Join(dir, ".ide", "worktrees", "1-data-export")
	tickets := ticket1(dir)
	tickets[3] = kbTicket{ID: 3, Title: "Export the rows", Parent: 1, Branch: "ticket/1-data-export"}
	s, main, child, wt := testAgents(t, dir, tickets, 3)
	sc := agentScope(t, s, main, child, true)

	text, err := callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 3, "provider": "claude"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "Session "+sessionID(text)+" of ticket #3 in "+wt) {
		t.Fatal(text)
	}
	m := agentsOfTest(t, s, child)
	sess, err := m.Get(sessionID(text))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "step ready", func() bool { return sess.Info().State == acp.Ready })
	if sess.Info().Ticket != 3 || sess.Info().Title != "#3 Export the rows" {
		t.Fatalf("%+v", sess.Info())
	}

	// The root's turn to work: the step is refused.
	s.host.Pod().(*fakePod).kanban = func(project, method string, params json.RawMessage) (json.RawMessage, error) {
		kb := &fakeKanban{tickets: tickets, step: 1}
		return kb.call(project, method, params)
	}
	_, err = callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 3, "provider": "claude"})
	if err == nil || !strings.Contains(err.Error(), "ticket #3 is not the step to develop of its lineage: the active step is #1") {
		t.Fatalf("step check: %v", err)
	}
}

// T5: a missing worktree, an unregistered one, a cwd that is not the worktree, and a grant that
// does not cover the worktree are refused before anything runs.
func TestAgentWorktreeScope(t *testing.T) {
	dir := t.TempDir()
	wt := filepath.Join(dir, ".ide", "worktrees", "1-data-export")
	tickets := ticket1(dir)
	tickets[2] = kbTicket{ID: 2, Title: "No worktree", Branch: "ticket/2-no-worktree"}
	tickets[4] = kbTicket{ID: 4, Title: "Unregistered", Branch: "ticket/4-unregistered", Worktree: filepath.Join(dir, ".ide", "worktrees", "4-unregistered")}
	s, main, child, wt := testAgents(t, dir, tickets, 1)
	sc := agentScope(t, s, main, child, true)
	m := agentsOfTest(t, s, child)

	for _, id := range []int64{2, 4} {
		_, err := callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": id, "provider": "claude"})
		if err == nil {
			t.Fatalf("ticket #%d accepted", id)
		}
		want := "the ticket has no worktree: start its development in the IDE first"
		if id == 4 {
			want = "the worktree of ticket #4 is not registered in the IDE: open the worktree first"
		}
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("ticket #%d: %v", id, err)
		}
	}
	// cwd outside the worktree.
	_, err := callMCP(t, s, "agent_start", agentScope(t, s, main, main, true), map[string]any{"cwd": dir, "id": 1, "provider": "claude"})
	if err == nil || !strings.Contains(err.Error(), "cwd must be the worktree of ticket #1 ("+wt+")") {
		t.Fatalf("cwd: %v", err)
	}
	// A grant that does not cover the worktree.
	_, err = callMCP(t, s, "agent_start", agentScope(t, s, main, child, false), map[string]any{"cwd": wt, "id": 1, "provider": "claude"})
	if err == nil || !strings.Contains(err.Error(), "the worktree is outside the MCP grant") {
		t.Fatalf("grant: %v", err)
	}
	if len(m.List()) != 0 {
		t.Fatalf("%d sessions started by refused calls", len(m.List()))
	}

	// A session id of another project is not found in the manager of cwd: the tools refuse it
	// and change nothing of the session.
	text, err := callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 1, "provider": "claude"})
	if err != nil {
		t.Fatal(err)
	}
	id := sessionID(text)
	sess, err := m.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session ready", func() bool { return sess.Info().State == acp.Ready })
	for _, name := range []string{"agent_read", "agent_send", "agent_stop"} {
		_, err := callMCP(t, s, name, agentScope(t, s, main, main, true), map[string]any{"cwd": dir, "session": id, "message": "zzz out of scope"})
		if err == nil || !strings.Contains(err.Error(), "agent session not found") {
			t.Fatalf("%s with a session of another project: %v", name, err)
		}
	}
	if len(agentsOfTest(t, s, main).List()) != 0 {
		t.Fatalf("the main project has %d sessions", len(agentsOfTest(t, s, main).List()))
	}
	if sess.Info().State != acp.Ready || len(sess.Info().Queue) != 0 {
		t.Fatalf("the session changed: %+v", sess.Info())
	}
}

// T6: agent_read is bounded by last, by tools, and by the length of the answer.
func TestAgentBoundedRead(t *testing.T) {
	dir := t.TempDir()
	s, main, child, wt := testAgents(t, dir, ticket1(dir), 1)
	sc := agentScope(t, s, main, child, true)

	text, err := callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 1, "provider": "claude"})
	if err != nil {
		t.Fatal(err)
	}
	id := sessionID(text)
	m := agentsOfTest(t, s, child)
	sess, err := m.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session ready", func() bool { return sess.Info().State == acp.Ready })

	tag := "zzzlongtagzzz"
	if _, err := callMCP(t, s, "agent_send", sc, map[string]any{"cwd": wt, "session": id, "message": "long " + tag}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "long turn ended", func() bool { return sess.Info().State == acp.Ready })

	// Only the last entry: the earlier ones are named, not sent.
	text, err = callMCP(t, s, "agent_read", sc, map[string]any{"cwd": wt, "session": id, "last": 1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "earlier entries left out") || !strings.Contains(text, tag+" done.") {
		t.Fatal(text)
	}
	// The long answer is cut.
	if !strings.Contains(text, "characters cut") {
		t.Fatal(text)
	}
	// A plain turn: its plan and its tool call show only with tools.
	if _, err := callMCP(t, s, "agent_send", sc, map[string]any{"cwd": wt, "session": id, "message": "plain check"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "plain turn ended", func() bool { return sess.Info().State == acp.Ready })

	// Without the tool calls, the plan and the tool line are absent.
	text, err = callMCP(t, s, "agent_read", sc, map[string]any{"cwd": wt, "session": id, "tools": false})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "Run "+tag) || strings.Contains(text, "Say hello") || strings.Contains(text, "Edit hello.txt") {
		t.Fatal(text)
	}
	if !strings.Contains(text, tag+" done.") || !strings.Contains(text, "Hello from the **fake agent**.") {
		t.Fatal(text)
	}
	text, err = callMCP(t, s, "agent_read", sc, map[string]any{"cwd": wt, "session": id, "tools": true})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "Run "+tag) || !strings.Contains(text, "Say hello") || !strings.Contains(text, "Edit hello.txt") {
		t.Fatal(text)
	}
}

// T7: a prompt sent while a turn runs is queued; agent_stop cancels the turn and drops the
// queue, so nothing resumes and the thread keeps what was already sent.
func TestAgentSendQueueStop(t *testing.T) {
	dir := t.TempDir()
	s, main, child, wt := testAgents(t, dir, ticket1(dir), 1)
	sc := agentScope(t, s, main, child, true)

	text, err := callMCP(t, s, "agent_start", sc, map[string]any{"cwd": wt, "id": 1, "provider": "claude"})
	if err != nil {
		t.Fatal(err)
	}
	id := sessionID(text)
	m := agentsOfTest(t, s, child)
	sess, err := m.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session ready", func() bool { return sess.Info().State == acp.Ready })

	if _, err := callMCP(t, s, "agent_send", sc, map[string]any{"cwd": wt, "session": id, "message": "zzzslow work"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "turn running", func() bool { return sess.Info().State == acp.Busy })
	text, err = callMCP(t, s, "agent_send", sc, map[string]any{"cwd": wt, "session": id, "message": "zzzmarker queued"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "your message is queued and sent at its next step") {
		t.Fatal(text)
	}
	text, err = callMCP(t, s, "agent_list", sc, map[string]any{"cwd": wt, "ticket": 1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "queued 1") {
		t.Fatal(text)
	}

	text, err = callMCP(t, s, "agent_stop", sc, map[string]any{"cwd": wt, "session": id})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "its turn is cancelled and its queued prompts dropped") {
		t.Fatal(text)
	}
	waitFor(t, "queue dropped", func() bool { return len(sess.Info().Queue) == 0 && sess.Info().State == acp.Ready })
	text, err = callMCP(t, s, "agent_read", sc, map[string]any{"cwd": wt, "session": id})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "zzzmarker") {
		t.Fatal("the dropped prompt reached the agent: " + text)
	}
	if !strings.Contains(text, "zzzslow work") {
		t.Fatal(text)
	}
}
