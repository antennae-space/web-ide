package install

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"time"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/store"
)

// The release archive of a version (a .tar.gz per architecture, its address in the manifest's
// assets) is downloaded, hashed, checked against the lock, extracted safely to
// <data>/plugins/<id>/<version>/, and the lock written. Nothing of it runs in this step.

// MaxAsset caps the size of a release archive, and of its content once extracted.
const MaxAsset = 100 << 20

// Installer installs the external plugins of a pod.
type Installer struct {
	Resolver
	Store *store.Store
	// Arch is the architecture of the archives (linux-amd64 by default: the pod's).
	Arch string
	// Client downloads the archives (a timeout by default).
	Client *http.Client
	// Official tells whether a repository is the one of an official plugin: installed from it,
	// a plugin is official (Locked.Official) whoever installs it.
	Official func(url string) bool
}

// Arch is the architecture of this pod, as the archives name it.
func Arch() string { return runtime.GOOS + "-" + runtime.GOARCH }

// Dir is the folder of the installed versions of a plugin.
func (in *Installer) Dir(id string) string { return in.Store.Path("plugins", id) }

// Install downloads and extracts a version resolved by Resolve, with the grants the user
// accepted (a part of the manifest's permissions), then writes it in the lock and removes its
// other versions.
func (in *Installer) Install(ctx context.Context, cand Candidate, constraint string, grants []string) (Locked, error) {
	m := cand.Manifest
	for _, g := range grants {
		if !slices.Contains(m.Permissions, g) {
			return Locked{}, i18n.Errorf("%s does not ask the permission %s", m.ID, g)
		}
	}
	asset := strings.NewReplacer("{version}", m.Version, "{arch}", in.Architecture()).Replace(m.Assets)
	tmp, sum, err := in.download(ctx, asset)
	if err != nil {
		return Locked{}, err
	}
	defer os.Remove(tmp)
	return in.place(tmp, sum, &m, cand.Tag, Locked{URL: cand.URL, Constraint: constraint, Grants: grants})
}

// InstallArchive installs a release archive at hand (an official plugin embedded in the pod,
// whose hash the caller checked): its manifest is the one inside. grants checks it and answers
// the permissions to grant (an error refuses the archive). l gives the URL, the constraint and
// Official.
func (in *Installer) InstallArchive(data []byte, l Locked, grants func(plugins.Manifest) ([]string, error)) (Locked, plugins.Manifest, error) {
	f, err := os.CreateTemp("", "web-ide-plugin-*.tar.gz")
	if err != nil {
		return Locked{}, plugins.Manifest{}, err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return Locked{}, plugins.Manifest{}, err
	}
	sum := sha256.Sum256(data)
	var m plugins.Manifest
	l.Grants = nil
	locked, err := in.place(f.Name(), hex.EncodeToString(sum[:]), nil, "", l, func(got plugins.Manifest) ([]string, error) {
		m = got
		return grants(got)
	})
	return locked, m, err
}

// Architecture is the one of the archives it installs (the pod's by default).
func (in *Installer) Architecture() string {
	if in.Arch != "" {
		return in.Arch
	}
	return Arch()
}

// place checks and extracts an archive (tmp, its sha256) to <data>/plugins/<id>/<version>/ and
// locks it. want is the manifest of its tag (nil: the archive's own is taken); grantsOf, when
// given, checks the manifest found and picks the grants.
func (in *Installer) place(tmp, sum string, want *plugins.Manifest, tag string, l Locked, grantsOf ...func(plugins.Manifest) ([]string, error)) (Locked, error) {
	if err := os.MkdirAll(in.Store.Path("plugins"), 0o700); err != nil {
		return Locked{}, err
	}
	work, err := os.MkdirTemp(in.Store.Path("plugins"), ".tmp-")
	if err != nil {
		return Locked{}, err
	}
	defer os.RemoveAll(work)
	if err := extract(tmp, work); err != nil {
		return Locked{}, err
	}
	data, err := os.ReadFile(filepath.Join(work, "plugin.json"))
	if err != nil {
		return Locked{}, i18n.Errorf("the archive has no plugin.json")
	}
	got, err := plugins.Parse(data)
	if err != nil {
		return Locked{}, err
	}
	if want != nil && !reflect.DeepEqual(got, *want) {
		return Locked{}, i18n.Errorf("the plugin.json of the archive of %s differs from the one of its tag %s", want.ID, tag)
	}
	m := got
	if len(grantsOf) > 0 {
		if l.Grants, err = grantsOf[0](m); err != nil {
			return Locked{}, err
		}
	}
	lock, err := ReadLock(in.Store)
	if err != nil {
		return Locked{}, err
	}
	prev, had := lock.Plugins[m.ID]
	if had && prev.URL != l.URL {
		return Locked{}, i18n.Errorf("a plugin %s is already installed from %s", m.ID, prev.URL)
	}
	// A locked version is never taken again under the same tag with another archive.
	if had && prev.Version == m.Version && prev.SHA256 != "" && prev.SHA256 != sum {
		return Locked{}, i18n.Errorf("the archive of %s %s changed since it was installed (sha256 %s, locked %s): refused", m.ID, m.Version, sum, prev.SHA256)
	}
	if m.Backend != "" {
		st, err := os.Lstat(filepath.Join(work, filepath.FromSlash(m.Backend)))
		if err != nil || !st.Mode().IsRegular() || st.Mode()&0o100 == 0 {
			return Locked{}, i18n.Errorf("the archive of %s has no executable %s", m.ID, m.Backend)
		}
	}
	if err := os.MkdirAll(in.Dir(m.ID), 0o700); err != nil {
		return Locked{}, err
	}
	final := filepath.Join(in.Dir(m.ID), m.Version)
	if err := os.RemoveAll(final); err != nil {
		return Locked{}, err
	}
	if err := os.Rename(work, final); err != nil {
		return Locked{}, err
	}
	if l.Grants == nil {
		l.Grants = []string{}
	}
	if in.Official != nil && in.Official(l.URL) {
		l.Official = true
	}
	if had && l.Destinations == nil {
		l.Destinations = prev.Destinations // allowed by the user, kept across versions
	}
	l.Version, l.SHA256 = m.Version, sum
	lock.Plugins[m.ID] = l
	lock.Declined = slices.DeleteFunc(lock.Declined, func(id string) bool { return id == m.ID })
	if err := WriteLock(in.Store, lock); err != nil {
		return Locked{}, err
	}
	// The other versions go once the lock names the new one.
	entries, _ := os.ReadDir(in.Dir(m.ID))
	for _, e := range entries {
		if e.Name() != m.Version {
			_ = os.RemoveAll(filepath.Join(in.Dir(m.ID), e.Name()))
		}
	}
	return l, nil
}

// Remove deletes an external plugin: its folder and its entry of the lock.
func (in *Installer) Remove(id string) error {
	lock, err := ReadLock(in.Store)
	if err != nil {
		return err
	}
	l, ok := lock.Plugins[id]
	if !ok {
		return errNotInstalled(id)
	}
	delete(lock.Plugins, id)
	// The pod does not put back an official plugin the user removed.
	if l.Official && !slices.Contains(lock.Declined, id) {
		lock.Declined = append(lock.Declined, id)
	}
	if err := WriteLock(in.Store, lock); err != nil {
		return err
	}
	return os.RemoveAll(in.Dir(id))
}

func errNotInstalled(id string) error { return i18n.Errorf("the plugin %s is not installed", id) }

// Manifest reads the plugin.json of an installed version.
func (in *Installer) Manifest(id, version string) (plugins.Manifest, error) {
	data, err := os.ReadFile(filepath.Join(in.Dir(id), version, "plugin.json"))
	if err != nil {
		return plugins.Manifest{}, err
	}
	return plugins.Parse(data)
}

// Fetch downloads the release archive of a resolved version for its architecture.
func (in *Installer) Fetch(ctx context.Context, cand Candidate) ([]byte, error) {
	asset := strings.NewReplacer("{version}", cand.Manifest.Version, "{arch}", in.Architecture()).Replace(cand.Manifest.Assets)
	tmp, _, err := in.download(ctx, asset)
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp)
	return os.ReadFile(tmp)
}

// download fetches an archive to a temporary file, with its sha256.
func (in *Installer) download(ctx context.Context, raw string) (file, sum string, err error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || !(u.Scheme == "https" || (u.Scheme == "http" && in.AllowHTTP && local(u.Hostname()))) {
		return "", "", i18n.Errorf("an archive is downloaded by https: %s", raw)
	}
	client := in.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Minute}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return "", "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", "", i18n.Errorf("downloading %s: %v", raw, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", i18n.Errorf("downloading %s: %s", raw, resp.Status)
	}
	f, err := os.CreateTemp("", "web-ide-plugin-*.tar.gz")
	if err != nil {
		return "", "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, MaxAsset+1))
	if err == nil && n > MaxAsset {
		err = i18n.Errorf("the archive %s is larger than %d MB", raw, MaxAsset>>20)
	}
	if err != nil {
		os.Remove(f.Name())
		return "", "", err
	}
	return f.Name(), hex.EncodeToString(h.Sum(nil)), nil
}

// errUnsafe: an entry of an archive that would write out of its folder, or is not a plain
// file, folder or link inside it.
var errUnsafe = errors.New("unsafe archive")

// extract unpacks a .tar.gz into dir: regular files, folders and links that stay inside it,
// nothing else; at most MaxAsset bytes.
func extract(archive, dir string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return i18n.Errorf("the archive is not a .tar.gz: %v", err)
	}
	tr := tar.NewReader(gz)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	var total int64
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return i18n.Errorf("reading the archive: %v", err)
		}
		name, ok := inside(h.Name)
		if !ok {
			return i18n.Errorf("%w: %s goes out of its folder", errUnsafe, h.Name)
		}
		if name == "" {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			total += h.Size
			if total > MaxAsset {
				return i18n.Errorf("%w: more than %d MB once extracted", errUnsafe, MaxAsset>>20)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			mode := os.FileMode(0o600)
			if h.Mode&0o111 != 0 {
				mode = 0o700
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, io.LimitReader(tr, h.Size))
			if cerr := out.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
		case tar.TypeSymlink:
			if path.IsAbs(h.Linkname) {
				return i18n.Errorf("%w: the link %s points out of its folder", errUnsafe, h.Name)
			}
			if _, ok := inside(path.Join(path.Dir(name), h.Linkname)); !ok {
				return i18n.Errorf("%w: the link %s points out of its folder", errUnsafe, h.Name)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			if err := os.Symlink(h.Linkname, target); err != nil {
				return err
			}
		default:
			return i18n.Errorf("%w: %s is not a file, a folder or a link", errUnsafe, h.Name)
		}
	}
}

// inside cleans the path of an entry: relative, never above its folder ("" for the folder).
func inside(name string) (string, bool) {
	name = strings.TrimPrefix(name, "./")
	if name == "" || name == "." {
		return "", true
	}
	if path.IsAbs(name) || strings.Contains(name, "\\") {
		return "", false
	}
	clean := path.Clean(name)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return clean, true
}

func randomID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Grants of a version: the ones it asks that the user had not accepted yet (an update).
func NewGrants(m plugins.Manifest, accepted []string) []string {
	var out []string
	for _, p := range m.Permissions {
		if !slices.Contains(accepted, p) {
			out = append(out, p)
		}
	}
	return out
}
