package server

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/runtime"
)

// The services between external plugins (docs/design/plugins.md, *Services between external
// plugins*, #155): a backend calls a method of the backend providing a capability its manifest
// requires, and hears the events that backend emits. Only between external plugins: a built-in's
// service runs unconfined, so an external reaches it through a core:<method> grant only.

// serviceProvider is the external plugin with a backend providing capability to the backend of
// caller in the project of rt.
func (s *Server) serviceProvider(rt *runtime.Runtime, caller plugins.External, capability string) (plugins.External, error) {
	if !slices.Contains(caller.Manifest.Requires, capability) {
		return plugins.External{}, i18n.Errorf("%s does not require %s", caller.Manifest.Name, capability)
	}
	id := plugins.Provider(s.pluginStates(rt), capability)
	if id == "" {
		return plugins.External{}, i18n.Errorf("nothing provides %s on this project", capability)
	}
	p, ok := s.Plugins.External(id)
	if !ok || p.Manifest.Backend == "" {
		return plugins.External{}, i18n.Errorf("%s is provided by %s, which an external plugin cannot call", capability, id)
	}
	return p, nil
}

// serviceCall runs service.call {capability, method, params, lang?} for the backend of caller:
// the method, of the provider's namespace, goes to its backend with the caller's id.
func (s *Server) serviceCall(ctx context.Context, rt *runtime.Runtime, caller plugins.External, params json.RawMessage) (any, error) {
	var a struct {
		Capability string          `json:"capability"`
		Method     string          `json:"method"`
		Params     json.RawMessage `json:"params"`
		Lang       string          `json:"lang"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	p, err := s.serviceProvider(rt, caller, a.Capability)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(a.Method, p.Manifest.ID+".") {
		return nil, i18n.Errorf("%s is not a method of %s", a.Method, p.Manifest.Name)
	}
	proc, err := s.backendOf(rt, p.Manifest.ID).process(ctx)
	if err != nil {
		return nil, err
	}
	return proc.Call(ctx, "call", map[string]any{"method": a.Method, "params": a.Params, "lang": a.Lang, "from": caller.Manifest.ID})
}

// serviceOn runs service.on {capability}: the events the provider's backend emits reach the
// backend of caller as the notification event {event, data}, while both run.
func (s *Server) serviceOn(rt *runtime.Runtime, caller plugins.External, params json.RawMessage) (any, error) {
	var a struct {
		Capability string `json:"capability"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	p, err := s.serviceProvider(rt, caller, a.Capability)
	if err != nil {
		return nil, err
	}
	s.backendOf(rt, p.Manifest.ID).listen(caller.Manifest.ID)
	return map[string]any{"provider": p.Manifest.ID}, nil
}

// listen adds a backend hearing the events of this one.
func (e *extPart) listen(id string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.listeners == nil {
		e.listeners = map[string]bool{}
	}
	e.listeners[id] = true
}

// relay gives an event of this backend to the backends listening to it, those still running.
func (e *extPart) relay(event string, data json.RawMessage) {
	e.mu.Lock()
	ids := make([]string, 0, len(e.listeners))
	for id := range e.listeners {
		ids = append(ids, id)
	}
	e.mu.Unlock()
	for _, id := range ids {
		l := e.s.backendOf(e.rt, id)
		l.mu.Lock()
		proc := l.proc
		l.mu.Unlock()
		if proc != nil {
			_ = proc.Notify("event", map[string]any{"event": event, "data": data})
		}
	}
}

// CallPlugin runs a method of a plugin in a project for a built-in (the AI reaching the
// Kanban once it is external): a method of an external plugin goes to its backend.
func (p podLend) CallPlugin(ctx context.Context, project, method string, params any) (json.RawMessage, error) {
	return p.s.callPlugin(ctx, project, method, params)
}

func (s *Server) callPlugin(ctx context.Context, project, method string, params any) (json.RawMessage, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	h := s.externalHandler(method)
	if h == nil {
		h = s.handlers[method]
	}
	if h == nil {
		return nil, i18n.Errorf("unknown method: %s", method)
	}
	c := newClient(s, ctx)
	c.project = project
	res, err := h(ctx, c, raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(res)
}
