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
	// Modals are the views an external plugin opens in a modal of the core (#154).
	Modals []ModalView `json:"modals,omitempty"`
	// Questions: an external plugin's backend asks the user through the Questions tool (#156).
	Questions bool `json:"questions,omitempty"`
	// Hooks are the moments of a project its backend is told of: project.open (#156).
	Hooks []string `json:"hooks,omitempty"`
	// Links are the parameters of a project's address opening one of its tab views (#155):
	// /project/<id>?ticket=12.
	Links []Link `json:"links,omitempty"`
	// AssistantTools are the names of the tools the plugin offers to the assistant and the MCP;
	// each one is registered with its handler (Host.AssistantTool).
	AssistantTools []string `json:"assistantTools,omitempty"`
	// MCPTools are the names of the tools it offers to the MCP only (Host.MCPTool).
	MCPTools []string `json:"mcpTools,omitempty"`
	// ToolSchemas describe the assistant and MCP tools of an external plugin, by name (a
	// built-in gives them in Go): run by its backend.
	ToolSchemas map[string]ToolSchema `json:"toolSchemas,omitempty"`
	Commands    []Command             `json:"commands,omitempty"`
	// Settings of the plugin (#151): rendered in Settings > Plugins, synced with the other
	// settings, read by its views (ide.settings) and its backend (settings.get).
	Settings *SettingsSchema `json:"settings,omitempty"`
	// Actions (#151): each one the method <id>.<action> of its backend, for its views, and the
	// assistant and MCP tool ActionTool; one by the AI that writes follows the user's policy.
	Actions []Action `json:"actions,omitempty"`
	// Languages make the plugin a language pack (#145): what it gives the language host.
	Languages []Language `json:"languages,omitempty"`
}

// Language is a language a pack gives the language host: its files (extensions, the LSP
// language id per extension when not its id), the files marking a project of it, its grammar
// (a file of the pack: a GrammarDef of the editor, data), its language servers (the first one
// whose program is found runs) and its test patterns ({".go": "{name}_test.go"}).
type Language struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Extensions  []string          `json:"extensions"`
	Markers     []string          `json:"markers,omitempty"`
	LanguageIDs map[string]string `json:"languageIds,omitempty"`
	Grammar     string            `json:"grammar,omitempty"`
	Servers     []LanguageServer  `json:"servers,omitempty"`
	Tests       map[string]string `json:"tests,omitempty"`
}

// LanguageServer is a language server: its program (a bare name found on the PATH of the host,
// granted as program:<name>) and arguments; the folders of the host it needs (each granted as
// path:<name>); the names of those added to its PATH (a toolchain's bin, "GOROOT/bin").
type LanguageServer struct {
	Argv     []string    `json:"argv"`
	Paths    []PathGrant `json:"paths,omitempty"`
	PathDirs []string    `json:"pathDirs,omitempty"`
	// Env are literal variables of its environment (GOTOOLCHAIN=local: no download, it has no
	// network), on this machine only.
	Env map[string]string `json:"env,omitempty"`
	// Install is how the IDE installs it when it is missing (#153), into the pack's folder of
	// tools: the core builds the command from it.
	Install *ServerInstall `json:"install,omitempty"`
}

// ServerInstall is the recipe of a server: a package manager the core knows (npm, pip, go) and
// what it installs (npm and pip packages, a Go module@version).
type ServerInstall struct {
	Manager  string   `json:"manager"`
	Packages []string `json:"packages"`
}

// InstallManagers are the package managers of the recipes.
var InstallManagers = []string{"npm", "pip", "go"}

// packageRe is a package of a recipe: a name, a version, extras (python-lsp-server[all],
// typescript@5, golang.org/x/tools/gopls@latest); no space, quote nor shell character.
var packageRe = regexp.MustCompile(`^[A-Za-z0-9@][A-Za-z0-9@._/+=<>~^,\[\]-]*$`)

// PathGrant is a folder of the host a server needs, by name: the first of its candidates that
// exists ($GOMODCACHE, $GOPATH/pkg/mod, ~/go/pkg/mod), read only unless Access is write; Env
// passes it to the server as the variable of its name.
type PathGrant struct {
	Name       string   `json:"name"`
	Candidates []string `json:"candidates"`
	Access     string   `json:"access,omitempty"`
	Env        bool     `json:"env,omitempty"`
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

// Link is a parameter of a project's address that opens a tab view of the plugin: its value is
// the key of the tab and the field param of its state, a number when Type says so.
type Link struct {
	Param string `json:"param"`
	View  string `json:"view"`
	Type  string `json:"type,omitempty"`
}

// coreParams are the parameters of a project's address the core reads itself.
var coreParams = []string{"open", "questions", "assistant", "chat", "desk"}

// ModalView is a view of a plugin shown in a modal of the core (ide.openModal).
type ModalView struct {
	ID    string `json:"id"`
	Label string `json:"label"`
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
	// programRe is the program of a language server: a bare name, found on the PATH.
	programRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]*$`)
	// pathNameRe names a folder a language server needs (GOMODCACHE).
	pathNameRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	extRe      = regexp.MustCompile(`^\.[A-Za-z0-9_+-]+$`)
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
	for _, v := range m.Contributes.Modals {
		if !idRe.MatchString(v.ID) || v.Label == "" {
			return fmt.Errorf("plugin %s: invalid modal view %q", m.ID, v.ID)
		}
	}
	for _, l := range m.Contributes.Links {
		if !idRe.MatchString(l.Param) || slices.Contains(coreParams, l.Param) || (l.Type != "" && l.Type != "number" && l.Type != "string") ||
			!slices.ContainsFunc(m.Contributes.TabViews, func(v TabView) bool { return v.ID == l.View }) {
			return fmt.Errorf("plugin %s: invalid link %q to view %q", m.ID, l.Param, l.View)
		}
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
	if err := m.checkLanguages(); err != nil {
		return err
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

// checkLanguages validates the languages of a pack: ids, extensions, the programs and folders of
// its servers, each one asked in its permissions.
func (m Manifest) checkLanguages() error {
	for _, l := range m.Contributes.Languages {
		if !idRe.MatchString(l.ID) || l.Name == "" || len(l.Extensions) == 0 {
			return fmt.Errorf("plugin %s: invalid language %q", m.ID, l.ID)
		}
		for _, e := range l.Extensions {
			if !extRe.MatchString(e) {
				return fmt.Errorf("plugin %s: language %s: invalid extension %q", m.ID, l.ID, e)
			}
		}
		if l.Grammar != "" && (!strings.HasPrefix(l.Grammar, "grammars/") || strings.Contains(l.Grammar, "..") || !strings.HasSuffix(l.Grammar, ".json")) {
			return fmt.Errorf("plugin %s: language %s: the grammar is a file grammars/<name>.json of the pack", m.ID, l.ID)
		}
		for _, sv := range l.Servers {
			if len(sv.Argv) == 0 || !programRe.MatchString(sv.Argv[0]) {
				return fmt.Errorf("plugin %s: language %s: a server's program is a bare name (found on the PATH)", m.ID, l.ID)
			}
			if !slices.Contains(m.Permissions, "program:"+sv.Argv[0]) {
				return fmt.Errorf("plugin %s: language %s: its server %s needs the permission program:%s", m.ID, l.ID, sv.Argv[0], sv.Argv[0])
			}
			if in := sv.Install; in != nil {
				if !slices.Contains(InstallManagers, in.Manager) || len(in.Packages) == 0 || (in.Manager == "go" && len(in.Packages) != 1) {
					return fmt.Errorf("plugin %s: language %s: invalid install of %s", m.ID, l.ID, sv.Argv[0])
				}
				for _, pk := range in.Packages {
					if !packageRe.MatchString(pk) {
						return fmt.Errorf("plugin %s: language %s: invalid package %q", m.ID, l.ID, pk)
					}
				}
			}
			names := map[string]bool{}
			for _, p := range sv.Paths {
				if !pathNameRe.MatchString(p.Name) || len(p.Candidates) == 0 || (p.Access != "" && p.Access != "read" && p.Access != "write") {
					return fmt.Errorf("plugin %s: language %s: invalid folder %q", m.ID, l.ID, p.Name)
				}
				if !slices.Contains(m.Permissions, "path:"+p.Name) {
					return fmt.Errorf("plugin %s: language %s: the folder %s needs the permission path:%s", m.ID, l.ID, p.Name, p.Name)
				}
				names[p.Name] = true
			}
			for k := range sv.Env {
				if !pathNameRe.MatchString(k) || k == "PATH" || k == "HOME" || k == "TMPDIR" || names[k] {
					return fmt.Errorf("plugin %s: language %s: invalid variable %q", m.ID, l.ID, k)
				}
			}
			for _, d := range sv.PathDirs {
				name, _, _ := strings.Cut(d, "/")
				if !names[name] || strings.Contains(d, "..") {
					return fmt.Errorf("plugin %s: language %s: %q is not under a folder of the server", m.ID, l.ID, d)
				}
			}
		}
	}
	return nil
}
