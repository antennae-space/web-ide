package install

import (
	"os"
	"path/filepath"
	"strings"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
)

// The folders of the host a language pack's server needs (#145, docs/design/plugins.md,
// *Language packs*): named in its manifest by candidates ($GOMODCACHE, $GOPATH/pkg/mod,
// ~/go/pkg/mod), resolved by the pod to the first that exists, without running any program.
// The grant shows the folder found; a folder holding the home, or one of the pod's data or of
// ~/.ssh, is never given.

// Host is what a resolution reads of the host.
type Host struct {
	Env  func(string) string
	Home string
	// Data is the pod's data folder (~/.web-ide).
	Data string
}

// ThisHost is the host of the pod.
func ThisHost(data string) Host {
	home, _ := os.UserHomeDir()
	return Host{Env: os.Getenv, Home: home, Data: data}
}

// expand turns a candidate into a path: ~/ the home, $NAME a variable (empty: none).
func (h Host) expand(c string) string {
	switch {
	case c == "~" || strings.HasPrefix(c, "~/"):
		return filepath.Join(h.Home, strings.TrimPrefix(c, "~"))
	case strings.HasPrefix(c, "$"):
		name, rest, _ := strings.Cut(c[1:], "/")
		v := h.Env(name)
		if v == "" {
			return ""
		}
		// A list (GOPATH=a:b): its first entry.
		v, _, _ = strings.Cut(v, string(os.PathListSeparator))
		return filepath.Join(v, rest)
	}
	return c
}

// within tells whether p is dir or inside it.
func within(p, dir string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}

// ResolvePath is the folder of a path grant on this host.
func (h Host) ResolvePath(g plugins.PathGrant) (string, error) {
	for _, c := range g.Candidates {
		p := h.expand(c)
		if p == "" || !filepath.IsAbs(p) {
			continue
		}
		p = filepath.Clean(p)
		if real, err := filepath.EvalSymlinks(p); err == nil {
			p = real
		} else {
			continue // missing
		}
		ssh := filepath.Join(h.Home, ".ssh")
		if within(h.Home, p) || within(p, ssh) || within(ssh, p) || (h.Data != "" && (within(p, h.Data) || within(h.Data, p))) {
			return "", i18n.Errorf("the folder %s of %s is refused: it holds the home, the data of the IDE or the SSH keys", p, g.Name)
		}
		return p, nil
	}
	return "", i18n.Errorf("no folder found for %s (%s)", g.Name, strings.Join(g.Candidates, ", "))
}

// ResolveProgram is the file of a program on the PATH of the host (its real path).
func (h Host) ResolveProgram(name string) (string, error) {
	for _, dir := range filepath.SplitList(h.Env("PATH")) {
		if dir == "" || !filepath.IsAbs(dir) {
			continue
		}
		p := filepath.Join(dir, name)
		st, err := os.Stat(p)
		if err != nil || st.IsDir() || st.Mode()&0o111 == 0 {
			continue
		}
		if real, err := filepath.EvalSymlinks(p); err == nil {
			return real, nil
		}
	}
	return "", i18n.Errorf("%s is not installed (not found on the PATH)", name)
}
