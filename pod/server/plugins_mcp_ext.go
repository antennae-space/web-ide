package server

import (
	"context"
	"encoding/json"
	"errors"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/sshx"
)

// The MCP tools of the external plugins (#156): `contributes.mcpTools`, described in
// `toolSchemas`, run by the backend of the project of the client's folder, which gets the
// scope of the call as a built-in's Host.MCPTool does.

// externalMCPTools are the MCP tools of the external plugins with a backend.
func (s *Server) externalMCPTools() []pluginMCPTool {
	var out []pluginMCPTool
	for _, e := range s.Plugins.Externals() {
		if e.Manifest.Backend == "" {
			continue
		}
		id := e.Manifest.ID
		for _, name := range e.Manifest.Contributes.MCPTools {
			sc := e.Manifest.Contributes.ToolSchemas[name]
			name := name
			out = append(out, pluginMCPTool{plugin: id, tool: plugins.MCPTool{Name: name, Description: sc.Description, Props: sc.Properties, Required: sc.Required,
				Run: func(ctx context.Context, scope plugins.MCPScope, args json.RawMessage) (string, error) {
					rt, err := s.openRuntime(scope.Here.ID, sshx.Creds{})
					if err != nil {
						return "", err
					}
					proc, err := s.backendOf(rt, id).process(ctx)
					if err != nil {
						return "", err
					}
					raw, err := proc.Call(ctx, "mcp", map[string]any{"name": name, "args": args, "lang": scope.Lang,
						"scope": map[string]any{"project": scope.Here.ID, "main": scope.Root.ID, "ticket": scope.Ticket, "url": scope.URL}})
					if err != nil {
						return "", err
					}
					var r struct {
						Content string `json:"content"`
						Error   bool   `json:"error"`
					}
					if err := json.Unmarshal(raw, &r); err != nil {
						return "", i18n.Errorf("the backend of %s answered %s badly: %v", id, name, err)
					}
					if r.Error {
						return "", errors.New(r.Content)
					}
					return r.Content, nil
				}}})
		}
	}
	return out
}

// allMCPTools are the MCP tools of the built-ins, then of the external plugins.
func (s *Server) allMCPTools() []pluginMCPTool {
	return append(append([]pluginMCPTool{}, s.plugins.mcp...), s.externalMCPTools()...)
}
