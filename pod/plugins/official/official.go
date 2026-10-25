// Package official lists the official plugins (docs/design/plugins.md, *Official plugins*): the
// external plugins of the antennae-space organisation that every pod installs by default, with
// their permissions granted, from the archives embedded in its release (else downloaded).
package official

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"

	"antennae.space/ide/pod/plugins/install"
)

// Entry is an official plugin at the version this IDE ships: where it comes from, the
// constraint of its updates, and the sha256 of its archive per architecture (linux-amd64…).
type Entry struct {
	ID         string            `json:"id"`
	URL        string            `json:"url"`
	Constraint string            `json:"constraint"`
	Version    string            `json:"version"`
	SHA256     map[string]string `json:"sha256"`
}

//go:embed official.json
var list []byte

// The archives of the architecture of this build, <id>-<version>.tar.gz (scripts/official.sh).
//
//go:embed all:archives/current
var archives embed.FS

// Source is where the list and the archives come from: the embedded ones, or a folder (a test,
// WEBIDE_OFFICIAL_DIR: official.json and archives/current/ inside).
type Source struct {
	list     []byte
	archives fs.FS
}

// Embedded is the source of this build.
func Embedded() Source {
	sub, _ := fs.Sub(archives, "archives/current")
	return Source{list: list, archives: sub}
}

// Dir is a source read from a folder.
func Dir(dir string) (Source, error) {
	data, err := os.ReadFile(filepath.Join(dir, "official.json"))
	if err != nil {
		return Source{}, err
	}
	return Source{list: data, archives: os.DirFS(filepath.Join(dir, "archives", "current"))}, nil
}

var idRe = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// List reads and checks the list.
func (s Source) List() ([]Entry, error) {
	var out []Entry
	if s.list == nil {
		return nil, nil // none (the tests of the server)
	}
	if err := json.Unmarshal(s.list, &out); err != nil {
		return nil, fmt.Errorf("official.json: %v", err)
	}
	for _, e := range out {
		if !idRe.MatchString(e.ID) || e.URL == "" || e.Version == "" {
			return nil, fmt.Errorf("official.json: invalid entry %+v", e)
		}
		if _, err := install.ParseVersion(e.Version); err != nil {
			return nil, fmt.Errorf("official.json: %s: %v", e.ID, err)
		}
		if _, err := install.ParseConstraint(e.Constraint); err != nil {
			return nil, fmt.Errorf("official.json: %s: %v", e.ID, err)
		}
	}
	return out, nil
}

// Archive is the embedded archive of an entry for this architecture, checked against its
// sha256 of the list; false when the build has none (a development build).
func (s Source) Archive(e Entry, arch string) ([]byte, bool, error) {
	data, err := fs.ReadFile(s.archives, e.ID+"-"+e.Version+".tar.gz")
	if err != nil {
		return nil, false, nil
	}
	if err := Check(e, arch, data); err != nil {
		return nil, false, err
	}
	return data, true, nil
}

// Check tells whether data is the archive the list names for arch.
func Check(e Entry, arch string, data []byte) error {
	want := e.SHA256[arch]
	if want == "" {
		return fmt.Errorf("official.json: %s %s has no sha256 for %s", e.ID, e.Version, arch)
	}
	sum := sha256.Sum256(data)
	if got := hex.EncodeToString(sum[:]); got != want {
		return fmt.Errorf("the archive of %s %s for %s is not the official one (sha256 %s, expected %s)", e.ID, e.Version, arch, got, want)
	}
	return nil
}
