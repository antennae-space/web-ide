// Package plugins is the plugin system of the pod (docs/design/plugins.md): the manifest of a
// plugin, the registry of the built-in plugins, the capabilities they provide and require, and
// their enabling per project (.ide/plugins.json of the main project).
package plugins

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// APIVersion is the version of the plugin API, frozen as 1 once Git moved (#118): a change of
// the API is a new version (docs/design/plugins.md, *API v1*).
const APIVersion = 1

// Manifest is the plugin.json of a plugin.
type Manifest struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Version    string `json:"version"`
	APIVersion int    `json:"apiVersion"`
	// Required: a locked plugin, always enabled (the IDE does not run without it: Files, Code).
	Required bool `json:"required,omitempty"`
	// Permissions are shown to the user (exec:docker, net…); not enforced for trusted plugins.
	Permissions []string `json:"permissions,omitempty"`
	Provides    []string `json:"provides,omitempty"`
	Requires    []string `json:"requires,omitempty"`
	// Namespaces are the prefixes of the RPC methods and the actions it owns besides its id
	// (console and commands for exec: their names were kept when the tool became a plugin).
	Namespaces  []string      `json:"namespaces,omitempty"`
	Contributes Contributions `json:"contributes"`
	// The fields of an external plugin (phase 3, pod/plugins/install): IDE is a semver
	// constraint on the version of the IDE (^1.24), Plugins the versions of the plugins it needs
	// (id -> constraint), Assets the address of its release archive, with {version} and {arch}
	// (linux-amd64, linux-arm64).
	IDE     string            `json:"ide,omitempty"`
	Plugins map[string]string `json:"plugins,omitempty"`
	Assets  string            `json:"assets,omitempty"`
	// Backend is the executable of its confined backend in its archive (bin/<name>, #130), ""
	// for none.
	Backend string `json:"backend,omitempty"`
}

// Owns tells whether a method or action name (prefix.name) belongs to the plugin.
func (m Manifest) Owns(name string) bool {
	prefix, _, ok := strings.Cut(name, ".")
	return ok && (prefix == m.ID || slices.Contains(m.Namespaces, prefix))
}

// Contributions are what a plugin adds to the IDE at each contribution point.
type Contributions struct {
	Tools    []Tool    `json:"tools,omitempty"`
	TabViews []TabView `json:"tabViews,omitempty"`
	// AssistantTools are the names of the tools the plugin offers to the assistant and the MCP;
	// each one is registered with its handler (Host.AssistantTool).
	AssistantTools []string `json:"assistantTools,omitempty"`
	// MCPTools are the names of the tools it offers to the MCP only (Host.MCPTool).
	MCPTools []string `json:"mcpTools,omitempty"`
	// ToolSchemas describe the assistant tools of an external plugin, by name (a built-in
	// gives them in Go): run by its backend.
	ToolSchemas map[string]ToolSchema `json:"toolSchemas,omitempty"`
	Commands    []Command             `json:"commands,omitempty"`
	// Settings of the plugin (#151): rendered in Settings > Plugins, synced with the other
	// settings, read by its views (ide.settings) and its backend (settings.get).
	Settings *SettingsSchema `json:"settings,omitempty"`
	// Actions (#151): each one the method <id>.<action> of its backend, for its views, and the
	// assistant and MCP tool ActionTool; one by the AI that writes follows the user's policy.
	Actions []Action `json:"actions,omitempty"`
}

// SettingsSchema are the settings of a plugin, by key.
type SettingsSchema struct {
	Properties map[string]Setting `json:"properties"`
}

// Setting is one setting: its type (string, number, boolean), the values it takes (enum, a
// string), its label and what it does, and its value by default.
type Setting struct {
	Type        string   `json:"type"`
	Enum        []string `json:"enum,omitempty"`
	Title       string   `json:"title"`
	Description string   `json:"description,omitempty"`
	Default     any      `json:"default,omitempty"`
}

// Action is something a plugin does for its views and for the AI from one declaration: its
// arguments (JSON Schema properties), whether it only reads (read) or changes something
// (write), and Target, the argument naming what it acts on (a connection), the unit of the
// user's policy for the AI.
type Action struct {
	ID          string         `json:"id"`
	Label       string         `json:"label"`
	Description string         `json:"description"`
	Properties  map[string]any `json:"properties"`
	Required    []string       `json:"required,omitempty"`
	Access      string         `json:"access"`
	Target      string         `json:"target,omitempty"`
}

// ActionTool is the name of the assistant tool of an action: <plugin>_<action>, dashes as
// underscores.
func (m Manifest) ActionTool(a Action) string {
	return strings.ReplaceAll(m.ID+"_"+a.ID, "-", "_")
}

// ToolSchema is an assistant tool as the model sees it: what it does, its arguments (JSON
// Schema properties) and those required.
type ToolSchema struct {
	Description string         `json:"description"`
	Properties  map[string]any `json:"properties"`
	Required    []string       `json:"required,omitempty"`
}

// toolNames are its tools of the assistant and of the MCP: one namespace.
func (c Contributions) toolNames() []string {
	return append(append([]string{}, c.AssistantTools...), c.MCPTools...)
}

// ToolNames are all its tools of the assistant and of the MCP, those of its actions included.
func (m Manifest) ToolNames() []string {
	out := m.Contributes.toolNames()
	for _, a := range m.Contributes.Actions {
		out = append(out, m.ActionTool(a))
	}
	return out
}

// Tool is a tool of the window, shown from a rail icon. Its command tool.<id> is implied.
type Tool struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Icon  string `json:"icon"`
	// Zone is the default tool zone: left, bottomLeft, bottomRight or right.
	Zone string `json:"zone"`
	// Before is the tool it comes before in its zone by default (else it comes last).
	Before string `json:"before,omitempty"`
}

// TabView is a kind of tab, opened as plugin:<plugin>/<id>.
type TabView struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Editor: the tab holds the text editor of the core above the plugin's view (#151).
	Editor *TabEditor `json:"editor,omitempty"`
}

// TabEditor is the editor of the core in a tab of a plugin: the grammar of its text (sql,
// redis…), its share of the tab's height in percent (40 by default), and the keys it gives the
// plugin's view by name while it has the focus ({"Ctrl+Enter": "run"}).
type TabEditor struct {
	Lang string            `json:"lang"`
	Size int               `json:"size,omitempty"`
	Keys map[string]string `json:"keys,omitempty"`
}

// Command is an action of the keymap, Search Everywhere and the menus, named <plugin>.<id>.
type Command struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Category string `json:"category,omitempty"`
	// Keys are its default shortcuts (physical keys: Ctrl+Enter, Alt+KeyD…).
	Keys []string `json:"keys,omitempty"`
	// Replaces is the id the action had before (a tool of the core moved to a plugin): the
	// shortcuts set by the user for it are kept.
	Replaces string `json:"replaces,omitempty"`
	// InTerminal: it also runs while a terminal has the focus.
	InTerminal bool `json:"inTerminal,omitempty"`
}

// Parse reads and checks a plugin.json.
func Parse(data []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return m, fmt.Errorf("invalid plugin.json: %v", err)
	}
	return m, m.Check()
}

var (
	idRe   = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	toolRe = regexp.MustCompile(`^[a-z][a-z_0-9]*$`)
	zones  = map[string]bool{"left": true, "bottomLeft": true, "bottomRight": true, "right": true}
	// comboRe is a shortcut as the keymap writes it: modifiers, then the physical key (Ctrl+Enter).
	comboRe = regexp.MustCompile(`^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?[A-Z][A-Za-z0-9]*$`)
)

// Check validates a manifest: ids, zones, the API version.
func (m Manifest) Check() error {
	if !idRe.MatchString(m.ID) {
		return fmt.Errorf("plugin id %q: lowercase letters, digits and dashes", m.ID)
	}
	if m.APIVersion != APIVersion {
		return fmt.Errorf("plugin %s: API version %d, the pod speaks %d", m.ID, m.APIVersion, APIVersion)
	}
	seen := map[string]bool{}
	for _, t := range m.Contributes.Tools {
		if !idRe.MatchString(t.ID) || seen[t.ID] {
			return fmt.Errorf("plugin %s: invalid or repeated tool id %q", m.ID, t.ID)
		}
		if !zones[t.Zone] {
			return fmt.Errorf("plugin %s: tool %s has no valid zone (%q)", m.ID, t.ID, t.Zone)
		}
		seen[t.ID] = true
	}
	for _, v := range m.Contributes.TabViews {
		if !idRe.MatchString(v.ID) {
			return fmt.Errorf("plugin %s: invalid tab view id %q", m.ID, v.ID)
		}
		if e := v.Editor; e != nil {
			if !idRe.MatchString(e.Lang) || e.Size < 0 || e.Size > 90 {
				return fmt.Errorf("plugin %s: tab view %s: invalid editor (lang %q, size %d)", m.ID, v.ID, e.Lang, e.Size)
			}
			for combo, name := range e.Keys {
				if !comboRe.MatchString(combo) || !idRe.MatchString(name) {
					return fmt.Errorf("plugin %s: tab view %s: invalid editor key %q: %q", m.ID, v.ID, combo, name)
				}
			}
		}
	}
	for _, n := range m.Namespaces {
		if !idRe.MatchString(n) {
			return fmt.Errorf("plugin %s: invalid namespace %q", m.ID, n)
		}
	}
	for _, c := range m.Contributes.Commands {
		if strings.Contains(c.ID, ".") && !m.Owns(c.ID) {
			return fmt.Errorf("plugin %s: command %s is out of its namespaces", m.ID, c.ID)
		}
	}
	for _, name := range m.Contributes.toolNames() {
		if !toolRe.MatchString(name) {
			return fmt.Errorf("plugin %s: invalid assistant tool name %q", m.ID, name)
		}
	}
	if st := m.Contributes.Settings; st != nil {
		for key, p := range st.Properties {
			if !toolRe.MatchString(key) || (p.Type != "string" && p.Type != "number" && p.Type != "boolean") || (len(p.Enum) > 0 && p.Type != "string") {
				return fmt.Errorf("plugin %s: invalid setting %q (type %q)", m.ID, key, p.Type)
			}
		}
	}
	tools := map[string]bool{}
	for _, name := range m.Contributes.toolNames() {
		tools[name] = true
	}
	for _, a := range m.Contributes.Actions {
		if !idRe.MatchString(a.ID) || (a.Access != "read" && a.Access != "write") || a.Description == "" {
			return fmt.Errorf("plugin %s: invalid action %q (access %q, a description needed)", m.ID, a.ID, a.Access)
		}
		if _, ok := a.Properties[a.Target]; a.Target != "" && !ok {
			return fmt.Errorf("plugin %s: action %s: its target %q is not one of its arguments", m.ID, a.ID, a.Target)
		}
		name := m.ActionTool(a)
		if !toolRe.MatchString(name) || tools[name] {
			return fmt.Errorf("plugin %s: action %s: its tool %s is invalid or taken", m.ID, a.ID, name)
		}
		tools[name] = true
	}
	return nil
}
