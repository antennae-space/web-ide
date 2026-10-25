package install

import (
	"regexp"
	"strings"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
)

// Grants are the permissions an external plugin may ask, each accepted by the user
// (docs/design/plugins.md, *Grants*): the project's files read or read-write, the network,
// running programs, connections the pod opens for it (dial, through SSH: ssh; each destination
// approved by the user), its entries of the vault (vault), and core:<method> for a method of
// the core it calls (core:fs.read).
var Grants = []string{"files:read", "files:write", "net", "exec", "dial", "ssh", "vault", "socket:docker", "terminal", "notify", "git", "gh", "worktrees", "use:assistant", "use:agents", "use:terminal"}

var backendRe = regexp.MustCompile(`^bin/[A-Za-z0-9._-]+$`)

var coreMethod = regexp.MustCompile(`^core:[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$`)

// The grants of a language pack (#145): a program its servers run (program:gopls), a folder of
// the host they need (path:GOMODCACHE, resolved by the pod).
var (
	programGrant = regexp.MustCompile(`^program:[A-Za-z0-9][A-Za-z0-9._+-]*$`)
	// A program run on the host of an SSH project (#152): exec:sqlite3.
	execGrant = regexp.MustCompile(`^exec:[A-Za-z0-9][A-Za-z0-9._+-]*$`)
	pathGrant = regexp.MustCompile(`^path:[A-Z][A-Z0-9_]*$`)
)

// ValidGrant tells whether a permission is a grant name.
func ValidGrant(p string) bool {
	for _, g := range Grants {
		if p == g {
			return true
		}
	}
	return coreMethod.MatchString(p) || programGrant.MatchString(p) || execGrant.MatchString(p) || pathGrant.MatchString(p)
}

// CheckExternal validates the manifest of an external plugin, beyond Manifest.Check: its
// release assets, its constraints, its permissions; none of the powers of a built-in (locked,
// namespaces of the core), nor the id of one.
func CheckExternal(m plugins.Manifest, builtin func(id string) bool) error {
	if err := m.Check(); err != nil {
		return err
	}
	if builtin(m.ID) {
		return i18n.Errorf("plugin %s: the id of a built-in plugin", m.ID)
	}
	if _, err := ParseVersion(m.Version); err != nil {
		return i18n.Errorf("plugin %s: invalid version %q", m.ID, m.Version)
	}
	if m.Assets == "" || !strings.Contains(m.Assets, "{arch}") {
		return i18n.Errorf("plugin %s: assets must give the address of its archives, with {arch}", m.ID)
	}
	if m.IDE != "" {
		if _, err := ParseConstraint(m.IDE); err != nil {
			return i18n.Errorf("plugin %s: invalid ide constraint %q", m.ID, m.IDE)
		}
	}
	for id, c := range m.Plugins {
		if _, err := ParseConstraint(c); err != nil {
			return i18n.Errorf("plugin %s: invalid constraint %q on %s", m.ID, c, id)
		}
	}
	for _, p := range m.Permissions {
		if !ValidGrant(p) {
			return i18n.Errorf("plugin %s: unknown permission %q", m.ID, p)
		}
	}
	if m.Backend != "" {
		if !backendRe.MatchString(m.Backend) || strings.Contains(m.Backend, "..") {
			return i18n.Errorf("plugin %s: its backend must be an executable of bin/, not %q", m.ID, m.Backend)
		}
	}
	for _, name := range m.Contributes.AssistantTools {
		if _, ok := m.Contributes.ToolSchemas[name]; !ok || m.Backend == "" {
			return i18n.Errorf("plugin %s: its assistant tool %s needs a schema and a backend", m.ID, name)
		}
	}
	for _, name := range m.Contributes.MCPTools {
		if _, ok := m.Contributes.ToolSchemas[name]; !ok || m.Backend == "" {
			return i18n.Errorf("plugin %s: its MCP tool %s needs a schema and a backend", m.ID, name)
		}
	}
	if (m.Contributes.Questions || len(m.Contributes.Hooks) > 0) && m.Backend == "" {
		return i18n.Errorf("plugin %s: its questions and hooks need a backend", m.ID)
	}
	for _, h := range m.Contributes.Hooks {
		if h != "project.open" {
			return i18n.Errorf("plugin %s: unknown hook %q", m.ID, h)
		}
	}
	if m.Required || len(m.Namespaces) > 0 {
		return i18n.Errorf("plugin %s: an external plugin cannot be locked nor own namespaces", m.ID)
	}
	return nil
}
