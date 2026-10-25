package server

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"strings"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/caps"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/runtime"
)

// The bridges of the core (docs/design/plugins.md, *Bridges*, #167): a reviewed part of a
// capability a built-in provides, which the core offers to the external plugins requiring it,
// on the grant use:<capability>. The bridge is the core's code: what an external plugin gets of
// a service that runs unconfined is what the bridge lets through, checked here.

// bridgeMethod runs a method of a bridge for the backend of e in the project of rt.
type bridgeMethod func(ctx context.Context, s *Server, rt *runtime.Runtime, e plugins.External, params json.RawMessage) (any, error)

// bridges are the methods of the bridges of the pod, by capability.
var bridges = map[string]map[string]bridgeMethod{
	"agents": {
		"agents.develop": func(ctx context.Context, s *Server, rt *runtime.Runtime, _ plugins.External, p json.RawMessage) (any, error) {
			a, err := bind[struct {
				Project string           `json:"project"`
				Agent   string           `json:"agent"`
				Ticket  caps.TicketBrief `json:"ticket"`
			}](p)
			if err != nil {
				return nil, err
			}
			ag, err := s.bridgeAgents(rt, a.Project)
			if err != nil {
				return nil, err
			}
			sess, created, err := ag.Develop(a.Project, a.Agent, a.Ticket)
			if err != nil {
				return nil, err
			}
			return map[string]any{"session": sess, "created": created}, nil
		},
		"agents.ticketSession": func(ctx context.Context, s *Server, rt *runtime.Runtime, _ plugins.External, p json.RawMessage) (any, error) {
			a, err := bind[struct {
				Project string `json:"project"`
				Ticket  int64  `json:"ticket"`
			}](p)
			if err != nil {
				return nil, err
			}
			ag, err := s.bridgeAgents(rt, a.Project)
			if err != nil {
				return nil, err
			}
			sess, found := ag.TicketSession(a.Project, a.Ticket)
			return map[string]any{"session": sess, "found": found}, nil
		},
		"agents.purge": func(ctx context.Context, s *Server, rt *runtime.Runtime, _ plugins.External, p json.RawMessage) (any, error) {
			a, err := bind[struct {
				Project string `json:"project"`
			}](p)
			if err != nil {
				return nil, err
			}
			ag, err := s.bridgeAgents(rt, a.Project)
			if err != nil {
				return nil, err
			}
			ag.Purge(a.Project)
			return map[string]any{}, nil
		},
		"agents.chatTimes": func(ctx context.Context, s *Server, rt *runtime.Runtime, _ plugins.External, p json.RawMessage) (any, error) {
			a, err := bind[struct {
				Project string `json:"project"`
			}](p)
			if err != nil {
				return nil, err
			}
			ag, err := s.bridgeAgents(rt, a.Project)
			if err != nil {
				return nil, err
			}
			return ag.ChatTimes(a.Project)
		},
	},
}

// bridgeAgents is the agents capability for a project of the family of rt: its main project or
// the project of the worktree of one of its tickets (<main>-t<n>), registered or not (purged).
func (s *Server) bridgeAgents(rt *runtime.Runtime, project string) (caps.Agents, error) {
	main := mainID(rt)
	n, isChild := strings.CutPrefix(project, main+"-t")
	if _, err := strconv.ParseInt(n, 10, 64); project != main && (!isChild || err != nil) {
		return nil, i18n.Errorf("%s is not a project of this one", project)
	}
	ag, ok := podLend{s}.Capability(rt, "agents").(caps.Agents)
	if !ok {
		return nil, i18n.Errorf("nothing provides %s on this project", "agents")
	}
	return ag, nil
}

// bridgeOf is the bridge of a capability a built-in provides on the project of rt, for an
// external plugin requiring it with its grant use:<capability>.
func (s *Server) bridgeOf(rt *runtime.Runtime, e plugins.External, capability string) (map[string]bridgeMethod, error) {
	b, ok := bridges[capability]
	id := plugins.Provider(s.pluginStates(rt), capability)
	if !ok || id == "" || !s.Plugins.Builtin(id) {
		return nil, nil
	}
	if !slices.Contains(e.Grants, "use:"+capability) {
		return nil, i18n.Errorf("%s is not granted to %s", "use:"+capability, e.Manifest.Name)
	}
	return b, nil
}
