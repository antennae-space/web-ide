package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	goruntime "runtime"
	"slices"
	"time"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/plugins/confine"
	"antennae.space/ide/pod/plugins/install"
	"antennae.space/ide/pod/plugins/official"
	"antennae.space/ide/pod/runtime"
)

// The external plugins of the pod (docs/design/plugins.md, *Phase 3*): resolved from their git
// repository, installed with the grants the user accepted, updated, removed. Listed, not
// runnable yet. Pod-wide: the lock is the pod's, each project says which ones it uses.

// installer is the one of the pod, made at registration, with the plugins installed now.
func (s *Server) installer() *install.Installer {
	in := *s.plugins.installer
	in.Installed = s.Plugins.Versions()
	return &in
}

func (s *Server) registerPluginInstall() {
	s.plugins.installer = &install.Installer{Store: s.Store, Resolver: install.Resolver{IDE: s.Version, Builtin: s.Plugins.Builtin,
		AllowHTTP: os.Getenv("WEBIDE_TEST_PLUGINS") != ""}}
	s.plugins.official = s.officialSource()
	s.plugins.installer.Official = s.officialURL
	s.loadExternals()
	go s.ensureOfficial()

	type resolveArgs struct {
		URL        string `json:"url"`
		Constraint string `json:"constraint"`
	}
	// plugins.resolve: the version an install would take, with what the grants dialog shows.
	s.handle("plugins.resolve", func(ctx context.Context, c *Client, p json.RawMessage) (any, error) {
		a, err := bind[resolveArgs](p)
		if err != nil {
			return nil, err
		}
		cand, err := s.resolvePlugin(ctx, a.URL, a.Constraint)
		if err != nil {
			return nil, err
		}
		return candidateView(cand, nil), nil
	})
	// plugins.install: the version resolved (version pins the one the dialog showed), with the
	// grants the user accepted.
	s.handle("plugins.install", func(ctx context.Context, c *Client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			resolveArgs
			Version string   `json:"version"`
			Grants  []string `json:"grants"`
		}](p)
		if err != nil {
			return nil, err
		}
		pin := a.Constraint
		if a.Version != "" {
			pin = "=" + a.Version
		}
		s.plugins.installMu.Lock()
		defer s.plugins.installMu.Unlock()
		cand, err := s.resolvePlugin(ctx, a.URL, pin)
		if err != nil {
			return nil, err
		}
		if _, ok := s.Plugins.External(cand.Manifest.ID); ok {
			return nil, i18n.Errorf("the plugin %s is installed already: update it", cand.Manifest.ID)
		}
		return s.installPlugin(ctx, cand, a.Constraint, a.Grants)
	})
	// plugins.update: the highest version of its constraint. A version asking a permission not
	// granted yet answers {grants}: the page asks the user, then calls again with them.
	s.handle("plugins.update", func(ctx context.Context, c *Client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			ID     string   `json:"id"`
			Grants []string `json:"grants"`
		}](p)
		if err != nil {
			return nil, err
		}
		s.plugins.installMu.Lock()
		defer s.plugins.installMu.Unlock()
		lock, err := install.ReadLock(s.Store)
		if err != nil {
			return nil, err
		}
		l, ok := lock.Plugins[a.ID]
		if !ok {
			return nil, i18n.Errorf("the plugin %s is not installed", a.ID)
		}
		cand, err := s.resolvePlugin(ctx, l.URL, l.Constraint)
		if err != nil {
			return nil, err
		}
		if cand.Version.String() == l.Version {
			return map[string]any{"upToDate": true, "version": l.Version}, nil
		}
		asked := install.NewGrants(cand.Manifest, l.Grants)
		if len(asked) > 0 && a.Grants == nil {
			return candidateView(cand, asked), nil
		}
		grants := []string{}
		for _, g := range cand.Manifest.Permissions {
			if slices.Contains(l.Grants, g) || slices.Contains(a.Grants, g) {
				grants = append(grants, g)
			}
		}
		return s.installPlugin(ctx, cand, l.Constraint, grants)
	})
	// plugins.grants: the permissions the user grants an installed plugin (Settings > Plugins: a
	// grant revoked or given again); its backends start again with them.
	s.handle("plugins.grants", func(ctx context.Context, c *Client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			ID     string   `json:"id"`
			Grants []string `json:"grants"`
		}](p)
		if err != nil {
			return nil, err
		}
		s.plugins.installMu.Lock()
		defer s.plugins.installMu.Unlock()
		e, ok := s.Plugins.External(a.ID)
		if !ok {
			return nil, i18n.Errorf("the plugin %s is not installed", a.ID)
		}
		for _, g := range a.Grants {
			if !slices.Contains(e.Manifest.Permissions, g) {
				return nil, i18n.Errorf("%s does not ask the permission %s", a.ID, g)
			}
		}
		l, err := install.SetGrants(s.Store, a.ID, a.Grants)
		if err != nil {
			return nil, err
		}
		e.Grants = l.Grants
		if err := s.Plugins.SetExternal(e); err != nil {
			return nil, err
		}
		s.dropBackends(a.ID)
		s.externalsChanged()
		return map[string]any{"grants": l.Grants}, nil
	})
	// plugins.destinations: the destinations the user still allows a plugin (Settings > Plugins:
	// one taken out is asked again at its next connection).
	s.handle("plugins.destinations", func(ctx context.Context, c *Client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			ID           string   `json:"id"`
			Destinations []string `json:"destinations"`
		}](p)
		if err != nil {
			return nil, err
		}
		s.plugins.installMu.Lock()
		defer s.plugins.installMu.Unlock()
		return nil, s.setDestinations(a.ID, a.Destinations)
	})
	// plugins.aiTargets: what a plugin's actions act on (its backend declared them), for the AI
	// access of Settings > Plugins.
	s.handle("plugins.aiTargets", func(ctx context.Context, c *Client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			ID string `json:"id"`
		}](p)
		if err != nil {
			return nil, err
		}
		list := s.aiTargets(a.ID)
		if list == nil {
			list = []aiTarget{}
		}
		return list, nil
	})
	// plugins.host: what this pod can run of an external plugin (the Landlock ABI of its kernel:
	// 0, no backend runs).
	s.handle("plugins.host", func(ctx context.Context, c *Client, p json.RawMessage) (any, error) {
		return map[string]any{"landlock": confine.ABI()}, nil
	})
	// plugins.bundle: what the page runs of an external plugin, in its sandboxed frames (#129):
	// its web/index.js and its catalogs.
	s.handle("plugins.bundle", func(ctx context.Context, c *Client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			ID string `json:"id"`
		}](p)
		if err != nil {
			return nil, err
		}
		return s.pluginBundle(a.ID)
	})
	// plugins.declined: the official plugins the user removed, which the pod leaves out; Settings
	// offers to install them again.
	s.handle("plugins.declined", func(ctx context.Context, c *Client, p json.RawMessage) (any, error) {
		lock, err := install.ReadLock(s.Store)
		if err != nil {
			return nil, err
		}
		list, _ := s.plugins.official.List()
		out := []map[string]string{}
		for _, e := range list {
			if slices.Contains(lock.Declined, e.ID) {
				out = append(out, map[string]string{"id": e.ID, "url": e.URL, "constraint": e.Constraint})
			}
		}
		return out, nil
	})
	s.handle("plugins.remove", func(ctx context.Context, c *Client, p json.RawMessage) (any, error) {
		a, err := bind[struct {
			ID string `json:"id"`
		}](p)
		if err != nil {
			return nil, err
		}
		s.plugins.installMu.Lock()
		defer s.plugins.installMu.Unlock()
		s.dropBackends(a.ID)
		if err := s.installer().Remove(a.ID); err != nil {
			return nil, err
		}
		s.Plugins.RemoveExternal(a.ID)
		s.externalsChanged()
		return nil, nil
	})
}

// maxBundle caps the page module of an external plugin (one file, its own Solid and CSS).
const maxBundle = 5 << 20

// pluginBundle reads the page module and the catalogs of an installed external plugin.
func (s *Server) pluginBundle(id string) (any, error) {
	e, ok := s.Plugins.External(id)
	if !ok {
		return nil, i18n.Errorf("the plugin %s is not installed", id)
	}
	dir := filepath.Join(s.plugins.installer.Dir(id), e.Version)
	st, err := os.Stat(filepath.Join(dir, "web", "index.js"))
	if err != nil || !st.Mode().IsRegular() {
		return nil, i18n.Errorf("the plugin %s has no web/index.js", id)
	}
	if st.Size() > maxBundle {
		return nil, i18n.Errorf("the page module of %s is larger than %d MB", id, maxBundle>>20)
	}
	js, err := os.ReadFile(filepath.Join(dir, "web", "index.js"))
	if err != nil {
		return nil, err
	}
	catalogs := map[string]map[string]string{}
	for _, lang := range i18n.Languages[1:] {
		data, err := os.ReadFile(filepath.Join(dir, "i18n", lang+".json"))
		if err != nil || len(data) > maxBundle {
			continue
		}
		c := map[string]string{}
		if json.Unmarshal(data, &c) == nil {
			catalogs[lang] = c
		}
	}
	return map[string]any{"version": e.Version, "js": string(js), "catalogs": catalogs}, nil
}

// resolvePlugin resolves a version of a repository, which must fit beside the built-ins.
func (s *Server) resolvePlugin(ctx context.Context, url, constraint string) (install.Candidate, error) {
	cand, err := s.installer().Resolve(ctx, url, constraint)
	if err != nil {
		return cand, err
	}
	if err := s.Plugins.CheckExternal(cand.Manifest); err != nil {
		return cand, i18n.Errorf("%s cannot be installed: %v", cand.Manifest.ID, err)
	}
	return cand, nil
}

func (s *Server) installPlugin(ctx context.Context, cand install.Candidate, constraint string, grants []string) (any, error) {
	s.dropBackends(cand.Manifest.ID) // its old version may run
	l, err := s.installer().Install(ctx, cand, constraint, grants)
	if err != nil {
		return nil, err
	}
	if err := s.Plugins.SetExternal(plugins.External{Manifest: cand.Manifest, URL: l.URL, Version: l.Version, Grants: l.Grants, Official: l.Official, Destinations: l.Destinations}); err != nil {
		return nil, err
	}
	s.externalsChanged()
	return map[string]any{"id": cand.Manifest.ID, "version": l.Version, "grants": l.Grants}, nil
}

// candidateView is a resolved version as the page shows it: asked are the permissions to
// accept (all of them for an install).
func candidateView(c install.Candidate, asked []string) map[string]any {
	if asked == nil {
		asked = c.Manifest.Permissions
	}
	if asked == nil {
		asked = []string{}
	}
	return map[string]any{"url": c.URL, "tag": c.Tag, "version": c.Version.String(), "manifest": c.Manifest, "grants": asked}
}

// loadExternals reads the lock at start: the installed versions join the registry.
func (s *Server) loadExternals() {
	lock, err := install.ReadLock(s.Store)
	if err != nil {
		log.Printf("plugins: %s: %v", install.LockFile, err)
		return
	}
	for id, l := range lock.Plugins {
		m, err := s.plugins.installer.Manifest(id, l.Version)
		if err == nil {
			err = s.Plugins.SetExternal(plugins.External{Manifest: m, URL: l.URL, Version: l.Version, Grants: l.Grants, Official: l.Official, Destinations: l.Destinations})
		}
		if err != nil {
			log.Printf("plugins: %s %s: %v", id, l.Version, err)
		}
	}
}

// externalsChanged tells every open project its plugins changed.
func (s *Server) externalsChanged() {
	s.mu.Lock()
	roots := map[string]bool{}
	var rts []*runtime.Runtime
	for _, rt := range s.runtimes {
		if rt != nil && !roots[mainID(rt)] {
			roots[mainID(rt)] = true
			rts = append(rts, rt)
		}
	}
	s.mu.Unlock()
	for _, rt := range rts {
		s.emitFamily(mainID(rt), "plugins.changed", map[string]any{"plugins": s.pluginStates(rt)})
	}
}

// officialSource is where the official plugins come from: this build, or a folder for the
// browser tests (WEBIDE_OFFICIAL_DIR, with WEBIDE_TEST_PLUGINS).
func (s *Server) officialSource() official.Source {
	if dir := os.Getenv("WEBIDE_OFFICIAL_DIR"); dir != "" && os.Getenv("WEBIDE_TEST_PLUGINS") != "" {
		src, err := official.Dir(dir)
		if err == nil {
			return src
		}
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("plugins: WEBIDE_OFFICIAL_DIR: %v", err)
		}
	}
	return official.Embedded()
}

// officialURL tells whether a repository is the one of an official plugin.
func (s *Server) officialURL(url string) bool {
	list, _ := s.plugins.official.List()
	for _, e := range list {
		if e.URL == url {
			return true
		}
	}
	return false
}

// ensureOfficial installs or upgrades the official plugins at start (docs/design/plugins.md,
// *Official plugins*), then tells the open projects.
func (s *Server) ensureOfficial() {
	if goruntime.GOOS != "linux" {
		return // their backends run under Landlock: Linux only
	}
	s.plugins.installMu.Lock()
	defer s.plugins.installMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	ms := official.Ensure(ctx, s.installer(), s.plugins.official, log.Printf)
	if len(ms) == 0 {
		return
	}
	lock, err := install.ReadLock(s.Store)
	if err != nil {
		log.Printf("plugins: %v", err)
		return
	}
	for _, m := range ms {
		l := lock.Plugins[m.ID]
		s.dropBackends(m.ID) // its old version may run
		if err := s.Plugins.SetExternal(plugins.External{Manifest: m, URL: l.URL, Version: l.Version, Grants: l.Grants, Official: true, Destinations: l.Destinations}); err != nil {
			log.Printf("plugins: official %s: %v", m.ID, err)
		} else {
			log.Printf("plugins: official %s %s installed", m.ID, m.Version)
		}
	}
	s.externalsChanged()
}

// setDestinations writes the destinations of a plugin to the lock and the registry, and tells
// the projects (installMu held).
func (s *Server) setDestinations(id string, dests []string) error {
	e, ok := s.Plugins.External(id)
	if !ok {
		return i18n.Errorf("the plugin %s is not installed", id)
	}
	l, err := install.SetDestinations(s.Store, id, dests)
	if err != nil {
		return err
	}
	e.Destinations = l.Destinations
	if err := s.Plugins.SetExternal(e); err != nil {
		return err
	}
	s.externalsChanged()
	return nil
}
