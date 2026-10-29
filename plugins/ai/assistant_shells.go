package ai

import (
	"slices"
	"time"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/pod/execx"
	"antennae.space/ide/pod/runtime"
)

// The consoles a conversation started (run_command, run_saved_command). The conversation keeps
// their ids; the top bar of the page shows how many still run, and the pod tells the windows
// when one starts or ends (assistant.shells).

// shellWatchEvery: how often a watcher looks at a console it started.
const shellWatchEvery = time.Second

// Shell is a console of a conversation that still runs.
type Shell struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Command string `json:"command,omitempty"`
	Since   int64  `json:"since"`
}

// shellsEvent tells the windows of a project the shells of one of its conversations.
type shellsEvent struct {
	ID     string  `json:"id"`
	Shells []Shell `json:"shells"`
}

// trackShell records the console a tool call started, tells the windows, and watches it until
// it ends. Called once per console started by a conversation.
func (s *A) trackShell(r *assistantRun, rt *runtime.Runtime, id string) {
	if id == "" {
		return
	}
	r.mu.Lock()
	if !slices.Contains(r.chat.Consoles, id) {
		r.chat.Consoles = append(r.chat.Consoles, id)
		s.publish(r, -1)
	}
	ev := shellsEvent{ID: r.id, Shells: runningShells(r.chat, rt)}
	root, project := r.root, r.project
	r.mu.Unlock()
	s.emitAssistant(root, "assistant.shells", ev)
	go s.watchShell(root, project, r.id, id, rt)
}

// watchShell follows one console of a conversation and tells the windows when it ends.
func (s *A) watchShell(root, project, chatID, id string, rt *runtime.Runtime) {
	for {
		time.Sleep(shellWatchEvery)
		if s.stopping() {
			return
		}
		info, _, _, err := rt.Consoles.Snapshot(id)
		if err != nil || info.Exited {
			break
		}
	}
	cc, err := s.chatLocOf(project)
	if err != nil {
		return
	}
	shells, err := s.pruneShells(cc, project, chatID)
	if err != nil {
		return
	}
	s.emitAssistant(root, "assistant.shells", shellsEvent{ID: chatID, Shells: shells})
}

// chatLocOf is where the conversations of a project are kept, and its root.
func (s *A) chatLocOf(project string) (chatCtx, error) {
	loc, root, err := s.ChatLoc(project)
	return chatCtx{loc, root}, err
}

// pruneShells drops from the conversation the consoles that ended and answers the ones still
// running. Without a runtime open for the project, the pod knows nothing about them: they stay.
func (s *A) pruneShells(cc chatCtx, project, id string) ([]Shell, error) {
	var out []Shell
	err := s.change(cc, id, func(c *engine.Chat, _ *assistantRun) (int, error) {
		rt := s.pod.OpenRuntime(project)
		if rt == nil {
			out = storedShells(c)
			return -1, nil
		}
		kept := runningShells(c, rt)
		out = kept
		ids := make([]string, 0, len(kept))
		for _, sh := range kept {
			ids = append(ids, sh.ID)
		}
		if !slices.Equal(c.Consoles, ids) {
			c.Consoles = ids
		}
		return -1, nil
	})
	return out, err
}

// runningShells lists the consoles of a conversation that still run, in the order they started.
func runningShells(c *engine.Chat, rt *runtime.Runtime) []Shell {
	if rt == nil || len(c.Consoles) == 0 {
		return nil
	}
	byID := map[string]consoleInfo{}
	for _, info := range rt.Consoles.List() {
		byID[info.ID] = consoleInfo{Title: info.Title, Command: execx.Join(info.Command), Exited: info.Exited, Started: info.Started}
	}
	out := []Shell{}
	for _, id := range c.Consoles {
		info, ok := byID[id]
		if !ok || info.Exited {
			continue
		}
		out = append(out, Shell{ID: id, Title: info.Title, Command: info.Command, Since: info.Started})
	}
	return out
}

// storedShells lists the consoles of a conversation as the conversation remembers them.
func storedShells(c *engine.Chat) []Shell {
	out := []Shell{}
	for _, id := range c.Consoles {
		out = append(out, Shell{ID: id})
	}
	return out
}

// consoleInfo is what a shell keeps of a console.
type consoleInfo struct {
	Title   string
	Command string
	Exited  bool
	Started int64
}
