package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/commands"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/projects"
	"antennae.space/ide/pod/runtime"
	"antennae.space/ide/pod/settingsync"
	"antennae.space/ide/pod/store"
)

// The unit tests of the plugin run on a pod of their own: real stores, no window, no Kanban
// (reached through Pod.CallPlugin). The tests through the RPC of a whole pod are in server.

func init() { assistant.Scratch = "/scratch-of-the-tests" }

type fakePod struct {
	svc *plugins.Services
	// rts: runtimes the tests give to the pod (a console manager for the shells).
	rts map[string]*runtime.Runtime
	// tools: the assistant tools of other plugins, by name: read only or not.
	tools map[string]bool
	// kanban answers the methods of the Kanban (the tests of the MCP agent tools set it).
	kanban func(project, method string, params json.RawMessage) (json.RawMessage, error)
}

func (p *fakePod) setRuntime(project string, rt *runtime.Runtime) {
	if p.rts == nil {
		p.rts = map[string]*runtime.Runtime{}
	}
	p.rts[project] = rt
}

func (p *fakePod) Runtime(project string) (*runtime.Runtime, error) {
	if rt := p.rts[project]; rt != nil {
		return rt, nil
	}
	return nil, errors.New("no runtime in the tests")
}
func (p *fakePod) OpenRuntime(project string) *runtime.Runtime           { return p.rts[project] }
func (p *fakePod) Project(string) (string, string, bool)                 { return "", "", false }
func (p *fakePod) Broadcast(string, any)                                 {}
func (p *fakePod) Emit(string, string, any)                              {}
func (p *fakePod) Authorized(*http.Request) bool                         { return false }
func (p *fakePod) AdvertiseChanged()                                     {}
func (p *fakePod) Gateway() (string, string)                             { return "", "" }
func (p *fakePod) Peers() plugins.Peers                                  { return nil }
func (p *fakePod) EmitFamily(string, string, any, string)                {}
func (p *fakePod) CloseRuntime(string)                                   {}
func (p *fakePod) Services() *plugins.Services                           { return p.svc }
func (p *fakePod) CapabilityOn(*runtime.Runtime, string) bool            { return true }
func (p *fakePod) Capability(*runtime.Runtime, string) any               { return nil }
func (p *fakePod) Stopping() bool                                        { return false }
func (p *fakePod) PackLanguages(*runtime.Runtime) []plugins.PackLanguage { return nil }
func (p *fakePod) PackCommand(*runtime.Runtime, string, plugins.LanguageServer) ([]string, error) {
	return nil, nil
}
func (p *fakePod) PackServers(*runtime.Runtime) []plugins.PackServer                 { return nil }
func (p *fakePod) PackDebuggers(*runtime.Runtime) []plugins.PackDebugger             { return nil }
func (p *fakePod) PackDebuggerServers(*runtime.Runtime) []plugins.PackDebuggerServer { return nil }
func (p *fakePod) DebuggerCommand(*runtime.Runtime, string, plugins.Debugger) ([]string, error) {
	return nil, nil
}
func (p *fakePod) InstallDebugger(*runtime.Runtime, string, string) (string, error) {
	return "", nil
}
func (p *fakePod) InstallServer(*runtime.Runtime, string, string) (string, error) {
	return "", nil
}
func (p *fakePod) AssistantTools(*runtime.Runtime) []json.RawMessage { return nil }
func (p *fakePod) Notify(plugins.Note)                               {}
func (p *fakePod) QuestionsChanged(string, string)                   {}
func (p *fakePod) Plugin(id string) (plugins.Plugin, bool)           { return nil, false }
func (p *fakePod) CallPlugin(ctx context.Context, project, method string, params any) (json.RawMessage, error) {
	if p.kanban == nil {
		return nil, errors.New("no Kanban in the tests of the AI")
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	return p.kanban(project, method, raw)
}
func (p *fakePod) UICall(context.Context, string, string, string, any, bool, time.Duration) (plugins.UIResult, bool, bool) {
	return plugins.UIResult{}, false, false
}
func (p *fakePod) AssistantToolReadOnly(name string) (bool, bool) {
	ro, ok := p.tools[name]
	return ro, ok
}

func (p *fakePod) RunAssistantTool(_ context.Context, _ *runtime.Runtime, name string, _ json.RawMessage, _ string, _ assistant.Options) (assistant.ToolResult, bool, error) {
	if _, ok := p.tools[name]; ok {
		return assistant.OKPlain("ran "+name, "ran"), true, nil
	}
	return assistant.ToolResult{}, false, nil
}
func (p *fakePod) CommandsText(*runtime.Runtime) (string, int, error) { return "", 0, nil }
func (p *fakePod) StartSaved(*runtime.Runtime, string, bool) (commands.Command, string, string, error) {
	return commands.Command{}, "", "", errors.New("no command in the tests")
}

// fakeHost records the MCP tools the plugin registers, so the tests call them as a client does.
type fakeHost struct {
	pod *fakePod
	mcp map[string]plugins.MCPTool
}

func (h fakeHost) Handle(string, plugins.Handler)                  {}
func (h fakeHost) HandleGlobal(string, plugins.Handler)            {}
func (h fakeHost) AssistantTool(plugins.AssistantTool)             {}
func (h fakeHost) MCPTool(t plugins.MCPTool)                       { h.mcp[t.Name] = t }
func (h fakeHost) Pod() plugins.Pod                                { return h.pod }
func (h fakeHost) OnProjectOpen(func(rt *runtime.Runtime))         {}
func (h fakeHost) OnWindows(func(n int))                           {}
func (h fakeHost) OnStart(func())                                  {}
func (h fakeHost) OnStop(func())                                   {}
func (h fakeHost) HandlePreview(func(string) (http.Handler, bool)) {}
func (h fakeHost) HandlePeer(http.Handler)                         {}
func (h fakeHost) Advertise(string, func() any)                    {}
func (h fakeHost) Provide(string, any)                             {}
func (h fakeHost) Questions(plugins.Questions)                     {}
func (h fakeHost) Vault(settingsync.VaultMap)                      {}

// newTestA is the plugin on a pod of its own, with a local project at dir.
func newTestA(t *testing.T, dir string) (*A, string) {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	reg, _ := projects.Load(st)
	p, err := reg.Create(projects.Project{Type: "local", Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	pod := &fakePod{svc: &plugins.Services{Store: st, Projects: reg}}
	s := New()
	s.Register(fakeHost{pod: pod, mcp: map[string]plugins.MCPTool{}})
	return s, p.ID
}
