package server

import (
	"context"
	"encoding/json"
	"strings"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/runtime"
)

// The questions of the external plugins (#156): a plugin with `contributes.questions` asks the
// user through the Questions tool. Its backends running in a main project and its worktrees
// list them (questions.list) and answer them (questions.answer); the core makes their ids its
// own, ext:<plugin>:<project>:<id>, and tells the windows when its backend says they changed.

// externalQuestions lists the questions of the running backends of the projects of root.
func (s *Server) externalQuestions(ctx context.Context, root string) []Question {
	var out []Question
	for _, rt := range s.familyRuntimes(root) {
		for _, e := range s.Plugins.Externals() {
			if !e.Manifest.Contributes.Questions || !s.pluginOn(rt, e.Manifest.ID) {
				continue
			}
			proc := s.backendOf(rt, e.Manifest.ID).running()
			if proc == nil {
				continue
			}
			raw, err := proc.Call(ctx, "questions.list", map[string]any{})
			var list []Question
			if err != nil || json.Unmarshal(raw, &list) != nil {
				continue
			}
			for _, q := range list {
				q.ID = "ext:" + e.Manifest.ID + ":" + rt.P.ID + ":" + q.ID
				q.Source, q.Project = e.Manifest.ID, rt.P.ID
				if q.Name == "" {
					q.Name = e.Manifest.Name
				}
				out = append(out, q)
			}
		}
	}
	return out
}

// answerExternal gives the answer of a question ext:<plugin>:<project>:<id> to its backend.
func (s *Server) answerExternal(ctx context.Context, root, id string, a plugins.Answer) error {
	parts := strings.SplitN(id, ":", 4)
	if len(parts) != 4 || s.questionRoot(parts[2]) != root {
		return i18n.New("this question is no longer open")
	}
	s.mu.Lock()
	rt := s.runtimes[parts[2]]
	s.mu.Unlock()
	if rt == nil {
		return i18n.New("this question is no longer open")
	}
	proc := s.backendOf(rt, parts[1]).running()
	if proc == nil {
		return i18n.New("this question is no longer open")
	}
	_, err := proc.Call(ctx, "questions.answer", map[string]any{"id": parts[3], "option": a.Option, "action": a.Action, "content": a.Content})
	return err
}

// familyRuntimes are the open runtimes of root and its worktrees.
func (s *Server) familyRuntimes(root string) []*runtime.Runtime {
	s.mu.Lock()
	all := make(map[string]*runtime.Runtime, len(s.runtimes))
	for id, rt := range s.runtimes {
		if rt != nil {
			all[id] = rt
		}
	}
	s.mu.Unlock()
	var out []*runtime.Runtime
	for id, rt := range all {
		if s.questionRoot(id) == root {
			out = append(out, rt)
		}
	}
	return out
}

// backendQuestionsChanged runs questions.changed {asked?} for a backend: the windows of its
// project ask again; asked, the name of who just asked, makes a push notification.
func (s *Server) backendQuestionsChanged(rt *runtime.Runtime, e plugins.External, params json.RawMessage) (any, error) {
	if !e.Manifest.Contributes.Questions {
		return nil, i18n.Errorf("%s asks no questions (contributes.questions)", e.Manifest.Name)
	}
	var a struct {
		Asked bool `json:"asked"`
	}
	_ = json.Unmarshal(params, &a)
	asked := ""
	if a.Asked {
		asked = e.Manifest.Name
	}
	s.questionsChanged(rt.P.ID, asked)
	return map[string]any{}, nil
}
