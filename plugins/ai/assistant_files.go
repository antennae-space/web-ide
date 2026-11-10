package ai

import (
	"slices"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/pod/assistant"
)

// addChanged notes on the conversation the file a write tool changed, absolute, once, in the
// order of the first change: the Explorer lists them under the conversation
// (docs/design/explorer.md). A refused or failed write changed nothing; the files a command
// changes are not known.
func (s *A) addChanged(r *assistantRun, ref *runtimeRef, name string, a assistant.Args, res *assistant.ToolResult) {
	if !engine.WriteTools[name] || res.Status != "ok" || a.Str("path") == "" {
		return
	}
	p := assistant.AbsPath(ref.rt.Root, a.Str("path"))
	r.mu.Lock()
	defer r.mu.Unlock()
	if !slices.Contains(r.chat.Files, p) {
		r.chat.Files = append(r.chat.Files, p)
	}
}
