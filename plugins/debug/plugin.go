// Package debug is the debug host of the IDE (docs/design/debug.md): a client of the Debug
// Adapter Protocol, fed by the debug adapters the language packs contribute (#188). It keeps one
// set of sessions per worktree (a runtime part), reads the configurations of `.ide/debug.json`
// and the breakpoints of `.ide/breakpoints.json`, and relays the events of the adapters
// (debug.session, debug.stopped, debug.output, debug.breakpoint) to the windows of the project.
// The Debug tool itself is #189; the host answers its methods and the assistant's later.
package debug

import (
	"context"
	_ "embed"
	"encoding/json"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/runtime"
)

//go:embed plugin.json
var manifest []byte

// pod is the pod the plugin runs in: the packs installed and their adapters, whose command the
// core builds (an adapter is not confined).
var pod plugins.Pod

type Plugin struct{ m plugins.Manifest }

func New() *Plugin {
	m, err := plugins.Parse(manifest)
	if err != nil {
		panic(err)
	}
	return &Plugin{m: m}
}

func (p *Plugin) Manifest() plugins.Manifest { return p.m }

func (p *Plugin) Register(h plugins.Host) {
	pod = h.Pod()
	h.Handle("debug.debuggers", func(ctx context.Context, c plugins.Call) (any, error) {
		return pod.PackDebuggerServers(c.Runtime), nil
	})
	// debug.configurations are the entries of .ide/debug.json, with the templates of the packs
	// the project uses (an empty file offers them).
	h.Handle("debug.configurations", func(ctx context.Context, c plugins.Call) (any, error) {
		cfgs, err := readConfigs(c.Runtime)
		if err != nil {
			return nil, err
		}
		return map[string]any{"configurations": cfgs, "templates": templatesOf(c.Runtime)}, nil
	})
	h.Handle("debug.templates", func(ctx context.Context, c plugins.Call) (any, error) {
		return templatesOf(c.Runtime), nil
	})
	// debug.start runs a configuration by name, or one given as it is (Run › Debug…, a template).
	h.Handle("debug.start", func(ctx context.Context, c plugins.Call) (any, error) {
		var p struct {
			Name   string         `json:"name"`
			Config map[string]any `json:"config"`
			File   string         `json:"file"`
		}
		if err := json.Unmarshal(c.Params, &p); err != nil {
			return nil, err
		}
		cfg := Config{}
		if p.Config != nil {
			cfg = Config{Fields: p.Config}
			cfg.Name, cfg.Type, cfg.Request = cfg.field("name"), cfg.field("type"), cfg.field("request")
			if cfg.Request == "" {
				cfg.Request = "launch"
			}
		} else {
			list, err := readConfigs(c.Runtime)
			if err != nil {
				return nil, err
			}
			found := false
			for _, x := range list {
				if x.Name == p.Name {
					cfg, found = x, true
					break
				}
			}
			if !found {
				return nil, i18n.Errorf("no debug configuration named %s", p.Name)
			}
		}
		if cfg.Type == "" {
			return nil, i18n.New("a debug configuration names its type")
		}
		s, err := sessionsOf(c.Runtime).startSession(cfg, p.File)
		if err != nil {
			return nil, err
		}
		return s.view(), nil
	})
	h.Handle("debug.sessions", func(ctx context.Context, c plugins.Call) (any, error) {
		return sessionsOf(c.Runtime).views(), nil
	})
	h.Handle("debug.stop", func(ctx context.Context, c plugins.Call) (any, error) {
		id, err := sessionID(c.Params)
		if err != nil {
			return nil, err
		}
		s, err := sessionsOf(c.Runtime).get(id)
		if err != nil {
			return nil, err
		}
		s.end()
		return nil, nil
	})
	h.Handle("debug.restart", func(ctx context.Context, c plugins.Call) (any, error) {
		id, err := sessionID(c.Params)
		if err != nil {
			return nil, err
		}
		m := sessionsOf(c.Runtime)
		s, err := m.get(id)
		if err != nil {
			return nil, err
		}
		cfg := Config{Name: s.Name, Type: s.Type, Request: s.Request, Fields: s.Config}
		s.end()
		fresh, err := m.startSession(cfg, "")
		if err != nil {
			return nil, err
		}
		return fresh.view(), nil
	})

	// The threads, the frames and the variables of a session (lazy: nothing crosses the relay
	// but what a row opens).
	sessionCall(h, "debug.threads", func(s *Session, params json.RawMessage) (any, error) {
		return s.request(10, "threads", map[string]any{})
	})
	sessionCall(h, "debug.stack", func(s *Session, params json.RawMessage) (any, error) {
		var p struct {
			Thread int `json:"thread"`
		}
		_ = json.Unmarshal(params, &p)
		return s.request(10, "stackTrace", map[string]any{"threadId": threadOf(s, p.Thread), "startFrame": 0, "levels": 0})
	})
	sessionCall(h, "debug.scopes", func(s *Session, params json.RawMessage) (any, error) {
		var p struct {
			Frame int `json:"frame"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return s.request(10, "scopes", map[string]any{"frameId": p.Frame})
	})
	sessionCall(h, "debug.variables", func(s *Session, params json.RawMessage) (any, error) {
		var p struct {
			Reference int `json:"reference"`
			Names     int `json:"names"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		args := map[string]any{"variablesReference": p.Reference}
		if p.Names > 0 {
			args["names"] = p.Names
		}
		return s.request(15, "variables", args)
	})
	sessionCall(h, "debug.evaluate", func(s *Session, params json.RawMessage) (any, error) {
		var p struct {
			Expression string `json:"expression"`
			Frame      int    `json:"frame"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.Expression == "" {
			return nil, i18n.New("evaluate needs an expression")
		}
		return s.request(15, "evaluate", map[string]any{"expression": p.Expression, "frameId": p.Frame, "context": "repl"})
	})
	// The steps and the run.
	sessionCall(h, "debug.continue", func(s *Session, params json.RawMessage) (any, error) {
		t, err := threadParam(s, params)
		if err != nil {
			return nil, err
		}
		res, err := s.request(10, "continue", map[string]any{"threadId": t})
		if err == nil {
			s.setState(stateRunning)
		}
		return res, err
	})
	sessionCall(h, "debug.pause", func(s *Session, params json.RawMessage) (any, error) {
		t, err := threadParam(s, params)
		if err != nil {
			return nil, err
		}
		return s.request(10, "pause", map[string]any{"threadId": t})
	})
	for _, step := range []struct{ method, command string }{
		{"debug.next", "next"}, {"debug.stepIn", "stepIn"}, {"debug.stepOut", "stepOut"},
	} {
		command := step.command
		sessionCall(h, step.method, func(s *Session, params json.RawMessage) (any, error) {
			t, err := threadParam(s, params)
			if err != nil {
				return nil, err
			}
			return s.request(10, command, map[string]any{"threadId": t})
		})
	}

	// The breakpoints of the worktree: read, and saved (then sent again to the live sessions).
	h.Handle("debug.breakpoints", func(ctx context.Context, c plugins.Call) (any, error) {
		return sessionsOf(c.Runtime).breakpoints.all(), nil
	})
	h.Handle("debug.setBreakpoints", func(ctx context.Context, c plugins.Call) (any, error) {
		var p struct {
			File        string       `json:"file"`
			Breakpoints []Breakpoint `json:"breakpoints"`
		}
		if err := json.Unmarshal(c.Params, &p); err != nil {
			return nil, err
		}
		if p.File == "" {
			return nil, i18n.New("the breakpoints name their file")
		}
		m := sessionsOf(c.Runtime)
		list, err := m.breakpoints.set(p.File, p.Breakpoints)
		if err != nil {
			return nil, err
		}
		sent := map[string][]map[string]any{}
		for _, s := range m.liveSessions() {
			kept, err := m.sendBreakpointsFor(s, p.File, list)
			if err != nil {
				continue
			}
			sent[s.ID] = kept
		}
		return map[string]any{"file": p.File, "breakpoints": list, "sent": sent}, nil
	})
	// debug.install runs the recipe of an adapter missing from the machine, in a console.
	h.Handle("debug.install", func(ctx context.Context, c plugins.Call) (any, error) {
		var p struct {
			Pack string `json:"pack"`
			Type string `json:"type"`
		}
		if err := json.Unmarshal(c.Params, &p); err != nil {
			return nil, err
		}
		return pod.InstallDebugger(c.Runtime, p.Pack, p.Type)
	})
}

// sessionCall adds a method acting on one session (its id in the parameters).
func sessionCall(h plugins.Host, method string, run func(s *Session, params json.RawMessage) (any, error)) {
	h.Handle(method, func(ctx context.Context, c plugins.Call) (any, error) {
		id, err := sessionID(c.Params)
		if err != nil {
			return nil, err
		}
		s, err := sessionsOf(c.Runtime).get(id)
		if err != nil {
			return nil, err
		}
		return run(s, c.Params)
	})
}

// sessionID reads the session id of a call.
func sessionID(params json.RawMessage) (string, error) {
	var p struct {
		Session string `json:"session"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return "", err
	}
	if p.Session == "" {
		return "", i18n.New("the call names its debug session")
	}
	return p.Session, nil
}

// threadOf is the thread a call acts on: the one it names, else the one the last stop reported.
func threadOf(s *Session, want int) int {
	if want > 0 {
		return want
	}
	if s.view().Thread > 0 {
		return s.view().Thread
	}
	return 1
}

func threadParam(s *Session, params json.RawMessage) (int, error) {
	var p struct {
		Thread int `json:"thread"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return 0, err
	}
	return threadOf(s, p.Thread), nil
}

// templatesOf are the ways the packs the project uses suggest to start or reach a program.
func templatesOf(rt *runtime.Runtime) []map[string]any {
	var out []map[string]any
	for _, d := range pod.PackDebuggers(rt) {
		for _, tp := range d.Debugger.Templates {
			var cfg map[string]any
			if len(tp.Config) > 0 {
				_ = json.Unmarshal(tp.Config, &cfg)
			}
			if cfg == nil {
				cfg = map[string]any{}
			}
			cfg["name"], cfg["type"], cfg["request"] = tp.Label, d.Debugger.Type, tp.Request
			out = append(out, map[string]any{"label": tp.Label, "pack": d.Pack, "packName": d.PackName,
				"type": d.Debugger.Type, "request": tp.Request, "config": cfg})
		}
	}
	return out
}
