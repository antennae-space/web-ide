package official

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/plugins/install"
	"antennae.space/ide/pod/store"
)

const url = "https://github.com/antennae-space/plugin-database"

// archive is the release archive of the plugin "database" at a version, asking perms.
func archive(t *testing.T, version string, perms ...string) []byte {
	t.Helper()
	m, _ := json.Marshal(map[string]any{"id": "database", "name": "Database", "version": version, "apiVersion": 1,
		"assets": "https://example.invalid/{version}/{arch}.tar.gz", "backend": "bin/db", "permissions": perms,
		"contributes": map[string]any{"tools": []any{map[string]any{"id": "database", "label": "Database", "icon": "database", "zone": "right"}}}})
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, f := range []struct {
		name, body string
		mode       int64
	}{{"plugin.json", string(m), 0o644}, {"bin/db", "#!/bin/sh\n", 0o755}, {"web/index.js", "ide.register({})", 0o644}} {
		_ = tw.WriteHeader(&tar.Header{Name: f.name, Mode: f.mode, Size: int64(len(f.body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(f.body))
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func sum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// source is a folder holding a list of one entry and its archive (none when data is nil).
func source(t *testing.T, version string, data []byte, sha string) Source {
	t.Helper()
	dir := t.TempDir()
	list := fmt.Sprintf(`[{"id":"database","url":%q,"constraint":"^1","version":%q,"sha256":{"linux-amd64":%q}}]`, url, version, sha)
	_ = os.WriteFile(filepath.Join(dir, "official.json"), []byte(list), 0o644)
	_ = os.MkdirAll(filepath.Join(dir, "archives", "current"), 0o755)
	if data != nil {
		_ = os.WriteFile(filepath.Join(dir, "archives", "current", "database-"+version+".tar.gz"), data, 0o644)
	}
	src, err := Dir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return src
}

func installer(t *testing.T) *install.Installer {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &install.Installer{Store: st, Arch: "linux-amd64"}
}

func lockOf(t *testing.T, in *install.Installer) install.Lock {
	l, err := install.ReadLock(in.Store)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func TestEnsureInstallsWithItsPermissions(t *testing.T) {
	in := installer(t)
	a := archive(t, "1.0.0", "net", "files:read")
	var logs []string
	logf := func(f string, args ...any) { logs = append(logs, fmt.Sprintf(f, args...)) }
	got := Ensure(context.Background(), in, source(t, "1.0.0", a, sum(a)), logf)
	if len(got) != 1 || got[0].ID != "database" || len(logs) > 0 {
		t.Fatalf("installed %v, logs %v", got, logs)
	}
	l := lockOf(t, in).Plugins["database"]
	if !l.Official || l.Version != "1.0.0" || l.URL != url || l.Constraint != "^1" || l.SHA256 != sum(a) || strings.Join(l.Grants, ",") != "net,files:read" {
		t.Fatalf("lock: %+v", l)
	}
	if _, err := os.Stat(filepath.Join(in.Dir("database"), "1.0.0", "bin", "db")); err != nil {
		t.Fatal(err)
	}
	// Nothing to do the next time.
	if got := Ensure(context.Background(), in, source(t, "1.0.0", a, sum(a)), logf); len(got) != 0 {
		t.Fatalf("installed again: %v", got)
	}
}

func TestEnsureRefusesAnotherArchive(t *testing.T) {
	in := installer(t)
	a := archive(t, "1.0.0")
	var logs []string
	got := Ensure(context.Background(), in, source(t, "1.0.0", a, strings.Repeat("0", 64)), func(f string, args ...any) { logs = append(logs, fmt.Sprintf(f, args...)) })
	if len(got) != 0 || len(logs) != 1 || !strings.Contains(logs[0], "not the official one") {
		t.Fatalf("installed %v, logs %v", got, logs)
	}
	if _, ok := lockOf(t, in).Plugins["database"]; ok {
		t.Fatal("locked")
	}
}

func TestEnsureRefusesAnArchiveOfAnotherVersion(t *testing.T) {
	in := installer(t)
	a := archive(t, "1.1.0")
	var logs []string
	Ensure(context.Background(), in, source(t, "1.0.0", a, sum(a)), func(f string, args ...any) { logs = append(logs, fmt.Sprintf(f, args...)) })
	if len(logs) != 1 || !strings.Contains(logs[0], "holds database 1.1.0") {
		t.Fatalf("logs %v", logs)
	}
	if _, ok := lockOf(t, in).Plugins["database"]; ok {
		t.Fatal("locked")
	}
}

// An upgrade keeps a revoked permission revoked and grants the new ones.
func TestEnsureUpgrade(t *testing.T) {
	in := installer(t)
	nop := func(string, ...any) {}
	a := archive(t, "1.0.0", "net", "files:read")
	Ensure(context.Background(), in, source(t, "1.0.0", a, sum(a)), nop)
	if _, err := install.SetGrants(in.Store, "database", []string{"files:read"}); err != nil { // net revoked
		t.Fatal(err)
	}
	b := archive(t, "1.2.0", "net", "files:read", "core:fs.list")
	got := Ensure(context.Background(), in, source(t, "1.2.0", b, sum(b)), nop)
	l := lockOf(t, in).Plugins["database"]
	if len(got) != 1 || l.Version != "1.2.0" || strings.Join(l.Grants, ",") != "files:read,core:fs.list" {
		t.Fatalf("upgraded %v: %+v", got, l)
	}
	if _, err := os.Stat(filepath.Join(in.Dir("database"), "1.0.0")); !os.IsNotExist(err) {
		t.Fatal("the old version stays")
	}
	// A lower version of the list does not downgrade.
	if got := Ensure(context.Background(), in, source(t, "1.0.0", a, sum(a)), nop); len(got) != 0 {
		t.Fatalf("downgraded: %v", got)
	}
}

func TestEnsureLeavesDeclinedAndOtherSources(t *testing.T) {
	in := installer(t)
	nop := func(string, ...any) {}
	a := archive(t, "1.0.0")
	Ensure(context.Background(), in, source(t, "1.0.0", a, sum(a)), nop)
	if err := in.Remove("database"); err != nil {
		t.Fatal(err)
	}
	if l := lockOf(t, in); !slices.Contains(l.Declined, "database") {
		t.Fatalf("declined: %+v", l)
	}
	if got := Ensure(context.Background(), in, source(t, "1.0.0", a, sum(a)), nop); len(got) != 0 {
		t.Fatalf("put back: %v", got)
	}

	// Installed by the user from another repository: left alone.
	in = installer(t)
	if _, _, err := in.InstallArchive(a, install.Locked{URL: "https://github.com/someone/database"}, func(plugins.Manifest) ([]string, error) { return nil, nil }); err != nil {
		t.Fatal(err)
	}
	b := archive(t, "1.2.0")
	var logs []string
	got := Ensure(context.Background(), in, source(t, "1.2.0", b, sum(b)), func(f string, args ...any) { logs = append(logs, fmt.Sprintf(f, args...)) })
	if l := lockOf(t, in).Plugins["database"]; len(got) != 0 || l.Version != "1.0.0" || l.Official || len(logs) != 1 || !strings.Contains(logs[0], "left alone") {
		t.Fatalf("another source: %v %+v %v", got, l, logs)
	}
}

// Installing an official plugin again takes it out of the declined ones.
func TestInstallTakesOutOfDeclined(t *testing.T) {
	in := installer(t)
	a := archive(t, "1.0.0")
	Ensure(context.Background(), in, source(t, "1.0.0", a, sum(a)), func(string, ...any) {})
	_ = in.Remove("database")
	if _, _, err := in.InstallArchive(a, install.Locked{URL: url, Official: true}, func(plugins.Manifest) ([]string, error) { return nil, nil }); err != nil {
		t.Fatal(err)
	}
	if l := lockOf(t, in); slices.Contains(l.Declined, "database") {
		t.Fatalf("still declined: %+v", l)
	}
}
