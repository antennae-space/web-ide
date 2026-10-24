package server

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/runtime"
	"antennae.space/ide/pod/store"
)

// The actions of an external plugin (docs/design/plugins.md, #151): one declaration in its
// manifest gives the method <id>.<action> of its backend, which its views call (the user acts,
// nothing to check), and the assistant and MCP tool <id>_<action>. When the AI runs an action
// that writes, the user's policy for its target decides: read only (the default: refused),
// ask (a question of the pod), allowed. The policies are the user's settings (pluginAI), the
// plugin cannot set them; it declares its targets (ai.targets) so Settings lists them.

// The AI policies of a target.
const (
	aiRead  = "read"
	aiAsk   = "ask"
	aiWrite = "write"
)

// settingsOf reads a part of the current settings (pluginSettings, pluginAI) for a plugin.
func (s *Server) settingsOf(part, id string) map[string]any {
	var all map[string]map[string]map[string]any
	_ = json.Unmarshal(s.Settings.Current().Settings, &all)
	if v := all[part][id]; v != nil {
		return v
	}
	return map[string]any{}
}

// pluginSettingValues are the settings of a plugin, its defaults where the user set nothing.
func (s *Server) pluginSettingValues(m plugins.Manifest) map[string]any {
	out := map[string]any{}
	if st := m.Contributes.Settings; st != nil {
		for k, p := range st.Properties {
			if p.Default != nil {
				out[k] = p.Default
			}
		}
	}
	for k, v := range s.settingsOf("pluginSettings", m.ID) {
		if st := m.Contributes.Settings; st != nil {
			if _, ok := st.Properties[k]; ok {
				out[k] = v
			}
		}
	}
	return out
}

// aiPolicy is the user's choice for the AI on a target of a plugin (read only by default).
func (s *Server) aiPolicy(id, target string) string {
	if p, _ := s.settingsOf("pluginAI", id)[target].(string); p == aiAsk || p == aiWrite {
		return p
	}
	return aiRead
}

// aiTargets are the targets the plugins declared, by plugin (ai-targets.json of the pod).
var aiTargetsMu sync.Mutex

type aiTarget struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

const aiTargetsFile = "ai-targets.json"

func (s *Server) aiTargets(id string) []aiTarget {
	aiTargetsMu.Lock()
	defer aiTargetsMu.Unlock()
	all := map[string][]aiTarget{}
	if err := s.Store.ReadJSON(aiTargetsFile, &all); err != nil && !store.IsNotExist(err) {
		return nil
	}
	return all[id]
}

func (s *Server) setAITargets(id string, list []aiTarget) error {
	aiTargetsMu.Lock()
	defer aiTargetsMu.Unlock()
	all := map[string][]aiTarget{}
	if err := s.Store.ReadJSON(aiTargetsFile, &all); err != nil && !store.IsNotExist(err) {
		return err
	}
	all[id] = list
	return s.Store.WriteJSON(aiTargetsFile, all)
}

// backendSettings answers the core calls of a backend about its settings and its targets.
func (s *Server) backendSettings(e plugins.External, method string, params json.RawMessage) (any, error) {
	switch method {
	case "settings.get":
		return s.pluginSettingValues(e.Manifest), nil
	case "ai.targets":
		a, err := bind[struct {
			Targets []aiTarget `json:"targets"`
		}](params)
		if err != nil {
			return nil, err
		}
		if len(a.Targets) > 1000 {
			return nil, i18n.Errorf("too many targets: %d", len(a.Targets))
		}
		for _, t := range a.Targets {
			if t.ID == "" || len(t.ID) > 200 || len(t.Label) > 200 {
				return nil, i18n.Errorf("invalid target %q", t.ID)
			}
		}
		if a.Targets == nil {
			a.Targets = []aiTarget{}
		}
		if err := s.setAITargets(e.Manifest.ID, a.Targets); err != nil {
			return nil, err
		}
		s.externalsChanged()
		return map[string]any{}, nil
	}
	return nil, nil
}

// actionTools are the assistant tools of the actions of the external plugins with a backend.
func (s *Server) actionTools() []pluginTool {
	var out []pluginTool
	for _, e := range s.Plugins.Externals() {
		if e.Manifest.Backend == "" {
			continue
		}
		for _, a := range e.Manifest.Contributes.Actions {
			id, a, name := e.Manifest.ID, a, e.Manifest.ActionTool(a)
			desc := a.Description
			if a.Access == "write" {
				desc += " It changes something: the user may refuse it or be asked first."
			}
			t := plugins.AssistantTool{Name: name, Description: desc, Props: a.Properties, Required: a.Required,
				Run: func(ctx context.Context, call plugins.Call) (plugins.Result, error) {
					return s.runAction(ctx, call, id, a)
				}}
			out = append(out, pluginTool{plugin: id, tool: t, def: assistant.Func(t.Name, t.Description, t.Props, t.Required...)})
		}
	}
	return out
}

// runAction runs an action for the AI: the user's policy first when it writes.
func (s *Server) runAction(ctx context.Context, call plugins.Call, id string, a plugins.Action) (plugins.Result, error) {
	e, ok := s.Plugins.External(id)
	if !ok {
		return plugins.Result{}, i18n.Errorf("the plugin %s is not installed", id)
	}
	if a.Access == "write" {
		var args map[string]any
		_ = json.Unmarshal(call.Params, &args)
		target := fmt.Sprint(args[a.Target])
		if a.Target == "" {
			target = "*"
		}
		switch s.aiPolicy(id, target) {
		case aiWrite:
		case aiAsk:
			if !s.askAIWrite(ctx, call.Runtime, e, a, target) {
				return plugins.Result{Content: fmt.Sprintf("The user did not allow %s on %s this time.", a.Label, target), Summary: assistant.Plain("not allowed"), Error: true}, nil
			}
		default:
			return plugins.Result{Content: fmt.Sprintf("%s changes %s, which the user lets the AI read only. They can allow it in Settings > Plugins > %s > AI access.", a.Label, target, e.Manifest.Name), Summary: assistant.Plain("read only"), Error: true}, nil
		}
	}
	proc, err := s.backendOf(call.Runtime, id).process(ctx)
	if err != nil {
		return plugins.Result{}, err
	}
	raw, err := proc.Call(ctx, "call", map[string]any{"method": id + "." + a.ID, "params": call.Params, "lang": call.Lang})
	if err != nil {
		return plugins.Result{Content: err.Error(), Summary: assistant.Plain("failed"), Error: true}, nil
	}
	return plugins.Result{Content: string(raw), Summary: assistant.Plain(a.Label)}, nil
}

// askAIWrite asks the user whether the AI may run a writing action on a target, once.
func (s *Server) askAIWrite(ctx context.Context, rt *runtime.Runtime, e plugins.External, a plugins.Action, target string) bool {
	q := plugins.Question{Source: "plugin", Project: rt.P.ID, Name: e.Manifest.Name, Title: e.Manifest.Name, Kind: "permission", Topic: "aiWrite", Text: a.Label, Target: target,
		Options: []plugins.Option{{ID: dialAllowOnce, Name: "Allow once", Kind: "allow_once"}, {ID: dialDeny, Name: "Deny", Kind: "reject_once"}}}
	return s.podAsks.ask(ctx, s, s.questionRoot(rt.P.ID), q, dialAskWait) == dialAllowOnce
}
