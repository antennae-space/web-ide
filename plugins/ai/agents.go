package ai

import (
	"net"
	"strconv"
	"strings"
	"sync"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/plugins/ai/acp"
	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/caps"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/projects"
	"antennae.space/ide/pod/runtime"
)

// The sessions of the Agents tool of a project are a part of its runtime (pod/runtime parts):
// made when a window opens the project, or on first use, and ended with it. The plugin keeps
// the open ones, for the Questions tool.

// agentsPart is the part of the runtime of a local project: the manager of its sessions.
type agentsPart struct {
	a       *A
	project string
	m       *acp.Manager
}

func (p *agentsPart) Stop(release bool) {
	if release {
		p.m.Release()
	} else {
		p.m.CloseAll()
	}
	p.a.agentParts.drop(p.project, p)
}

// agentParts are the parts of the open projects, by project.
type agentParts struct {
	mu   sync.Mutex
	open map[string]*agentsPart
}

func (r *agentParts) add(p *agentsPart) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.open[p.project] = p
}

func (r *agentParts) drop(project string, p *agentsPart) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.open[project] == p {
		delete(r.open, project)
	}
}

func (r *agentParts) list() []*agentsPart {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*agentsPart, 0, len(r.open))
	for _, p := range r.open {
		out = append(out, p)
	}
	return out
}

// devReserve keeps one active development per worktree, owned by an Assistant conversation
// or an ACP session.
type devReserve struct {
	mu sync.Mutex
	by map[string]string
}

// take returns the other development's id if the worktree is already reserved.
func (r *devReserve) take(key, id string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if cur := r.by[key]; cur != "" && cur != id {
		return cur
	}
	r.by[key] = id
	return ""
}

// setOwner records the session that owns the development.
func (r *devReserve) setOwner(key, id string) {
	r.mu.Lock()
	r.by[key] = id
	r.mu.Unlock()
}

// release frees the ticket (the turn ended, the start failed, the session closed).
func (r *devReserve) release(key, id string) {
	r.mu.Lock()
	if r.by[key] == id {
		delete(r.by, key)
	}
	r.mu.Unlock()
}

// agentsOf is the manager of the sessions of the project of rt (nil on an SSH project: local
// only for now).
func (s *A) agentsOf(rt *runtime.Runtime) *acp.Manager {
	if !rt.Local || s.Store == nil {
		return nil
	}
	return rt.Part("agents", func() any {
		p := &agentsPart{a: s, project: rt.P.ID}
		free := func(info acp.Info) {
			s.devReserve.release(rt.P.ID, info.ID)
		}
		p.m = acp.NewManager(acp.Deps{Keeper: s.Keeper, Owner: rt.P.ID, Dir: s.Store.Path("agents", rt.P.ID), Root: rt.Root,
			Catalog: acp.Catalog{Dir: s.Store.Path("acp")}, Version: s.Version, Command: s.testAgentCommand,
			MCP: func(session string) []acp.MCPServer { return s.agentsMCP(rt.P.ID, session) }, Emit: rt.Emit,
			BeforePrompt: func(info acp.Info) error {
				if info.Ticket != 0 || rt.P.Parent != "" {
					return s.reserveDevelopment(rt.P.ID, info.Ticket, info.ID)
				}
				return nil
			},
			OnPromptError: free, OnTurn: func(info acp.Info) { free(info); go s.quotaTurn() }, OnState: free,
			OnClosed: func(info acp.Info) {
				if revoke := s.pod.Services().RevokeACPMCP; revoke != nil {
					revoke(rt.P.ID, info.ID)
				}
				s.stopDelegation(rt.P.ID, info.ID)
				free(info)
			}})
		s.agentParts.add(p)
		return p
	}).(*agentsPart).m
}

func (s *A) reserveDevelopment(project string, ticket int64, id string) error {
	if owner := s.devReserve.take(project, id); owner != "" {
		if ticket != 0 {
			return i18n.Errorf("ticket #%d already has an active development (session %s)", ticket, owner)
		}
		return i18n.Errorf("the worktree already has an active development (session %s)", owner)
	}
	return nil
}

// agentsMCP is the MCP server of the IDE as the sessions of the Agents tool reach it: the
// listen address of the pod, a Developer credential as a bearer. Named like the server users add to Claude
// Code (web-ide), so that the session's one replaces it instead of doubling its tools.
func (s *A) agentsMCP(project, session string) []acp.MCPServer {
	svc := s.pod.Services() // read again: the address may be set after the registration
	base := svc.MCPBase
	if base == "" && svc.Cfg != nil && svc.Cfg.Addr != "" {
		host, port, err := net.SplitHostPort(svc.Cfg.Addr)
		if err != nil {
			return nil
		}
		if host == "" || host == "0.0.0.0" || host == "::" {
			host = "127.0.0.1"
		}
		base = "http://" + net.JoinHostPort(host, port)
	}
	if base == "" || svc.ACPMCPToken == nil {
		return nil
	}
	token, err := svc.ACPMCPToken(project, session)
	if err != nil {
		return nil
	}
	return []acp.MCPServer{{Type: "http", Name: "web-ide", URL: strings.TrimSuffix(base, "/") + plugins.MCPPath,
		Headers: []acp.Header{{Name: "Authorization", Value: "Bearer " + token}}}}
}

// rootOf is the main project of a project (a worktree's parent), whose windows show its
// questions.
func (s *A) rootOf(project string) string {
	if p, err := s.Projects.Root(project); err == nil {
		return p.ID
	}
	return project
}

// agentQuestions are the questions of the sessions of the open projects of root: a permission
// or a form.
func (s *A) agentQuestions(root string) []plugins.Question {
	var out []plugins.Question
	for _, p := range s.agentParts.list() {
		if s.rootOf(p.project) != root {
			continue
		}
		for _, a := range p.m.Questions() {
			q := plugins.Question{ID: "acp:" + p.project + ":" + a.Session + ":" + strconv.Itoa(a.Index), Source: "acp", Project: p.project, Session: a.Session, Index: a.Index,
				Name: a.Name, Title: a.Title, Last: a.Last, Time: a.Entry.Time, AutoOpen: a.AutoOpen}
			if a.Entry.Kind == "permission" {
				q.Kind, q.Text = "permission", a.Entry.Title
				for _, o := range a.Entry.Options {
					q.Options = append(q.Options, plugins.Option{ID: o.ID, Name: o.Name, Kind: o.Kind})
				}
			} else {
				q.Kind, q.Text, q.Schema = "form", a.Entry.Text, a.Entry.Schema
			}
			out = append(out, q)
		}
	}
	return out
}

// answerAgent answers a question of a session (id acp:<project>:<session>:<index>).
func (s *A) answerAgent(root, id string, a plugins.Answer) error {
	parts := strings.Split(id, ":")
	if len(parts) != 4 || s.rootOf(parts[1]) != root {
		return i18n.New("this question is no longer open")
	}
	rt := s.pod.OpenRuntime(parts[1])
	if rt == nil {
		return i18n.New("this question is no longer open")
	}
	m := s.agentsOf(rt)
	if m == nil {
		return i18n.New("this question is no longer open")
	}
	sess, err := m.Get(parts[2])
	if err != nil {
		return err
	}
	index, _ := strconv.Atoi(parts[3])
	if a.Option != "" {
		return sess.Answer(index, a.Option)
	}
	return sess.AnswerForm(index, a.Action, a.Content)
}

// agentsCap is the agents capability, as the Kanban uses it (pod/caps).
type agentsCap struct{ s *A }

// developTicket schedules the work of a ticket in its session, in the project of its worktree:
// the path shared by the Kanban UI (caps.Agents) and the MCP supervisor tools. It reuses the
// idle session of the ticket when the provider and the model match, else opens a new one. The
// ticket is reserved before the first prompt is scheduled, so that a second development of the
// same ticket fails cleanly.
func (s *A) developTicket(project, agent string, t caps.TicketBrief) (caps.AgentSession, bool, error) {
	if _, ok := engine.RoleInstructions[t.Role]; !ok {
		return caps.AgentSession{}, false, i18n.Errorf("unknown role: %s", t.Role)
	}
	rt, err := s.pod.Runtime(project)
	if err != nil {
		return caps.AgentSession{}, false, err
	}
	m := s.agentsOf(rt)
	if m == nil {
		return caps.AgentSession{}, false, i18n.New("agents run on local projects only")
	}
	prompt := engine.AgentPrompt(t.ID, t.Role, t.Branch, t.Parent, t.Feedback, t.Markdown)
	if t.Text != "" {
		prompt += "\n\n---\n\n" + t.Text
	}
	key := project
	id := assistant.NewID()
	if err := s.reserveDevelopment(project, t.ID, id); err != nil {
		return caps.AgentSession{}, false, err
	}
	for _, info := range m.List() {
		if info.Ticket != t.ID {
			continue
		}
		if info.State == acp.Starting || info.State == acp.Busy || info.State == acp.Asking {
			s.devReserve.release(key, id)
			return caps.AgentSession{}, false, i18n.Errorf("ticket #%d has a development running (session %s, %s)", t.ID, info.ID, info.State)
		}
		if info.Agent != agent || (t.Model != "" && info.Model() != t.Model) {
			continue
		}
		if info.State == acp.Failed {
			continue // its end is in the thread: a retry opens a new session
		}
		sess, err := m.Get(info.ID)
		if err != nil {
			break
		}
		s.devReserve.setOwner(key, info.ID)
		if err := sess.Prompt(prompt); err != nil {
			s.devReserve.release(key, info.ID)
			return caps.AgentSession{}, false, err
		}
		return sessionOf(info), false, nil
	}
	info, err := m.CreateWith(agent, "", acp.Options{ID: id, Title: "#" + strconv.FormatInt(t.ID, 10) + " " + t.Title, Ticket: t.ID, Prompt: prompt, Model: t.Model})
	if err != nil {
		s.devReserve.release(key, id)
		return caps.AgentSession{}, false, err
	}
	s.pod.Emit(project, "agents.created", info)
	return sessionOf(info), true, nil
}

func (c agentsCap) Develop(project, agent string, t caps.TicketBrief) (caps.AgentSession, bool, error) {
	return c.s.developTicket(project, agent, t)
}

func (c agentsCap) TicketSession(project string, ticket int64) (caps.AgentSession, bool) {
	info, _, ok := acp.Find(c.s.Store.Path("agents", project), ticket)
	return sessionOf(info), ok
}

func (c agentsCap) Purge(project string) {
	acp.Purge(c.s.Keeper, project, c.s.Store.Path("agents", project))
}

func (c agentsCap) ChatTimes(project string) (map[string]caps.ChatTime, error) {
	loc, _, err := c.s.ChatLoc(project)
	if err != nil {
		return nil, err
	}
	times, err := c.s.LLM.ChatTimes(loc)
	if err != nil {
		return nil, err
	}
	out := make(map[string]caps.ChatTime, len(times))
	for id, t := range times {
		out[id] = caps.ChatTime{Parent: t.Parent, Ms: t.Ms, ThinkMs: t.ThinkMs, Chars: t.Chars}
	}
	return out, nil
}

// ticketSession finds the session of a ticket in the files of the Agents tool of its worktree
// (the one of the root of its lineage), open or not.
func (s *A) ticketSession(root string, id, parent int64) (acp.Info, []acp.Entry, bool) {
	owner := id
	if parent != 0 {
		owner = parent
	}
	return acp.Find(s.Store.Path("agents", projects.ChildID(root, owner)), id)
}

func sessionOf(info acp.Info) caps.AgentSession {
	return caps.AgentSession{ID: info.ID, Name: info.Name, Title: info.Title, State: info.State}
}
