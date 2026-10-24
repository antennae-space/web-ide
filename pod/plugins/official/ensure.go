package official

import (
	"context"
	"fmt"
	"slices"

	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/plugins/install"
)

// Ensure installs the official plugins of src a pod lacks, and upgrades those it has at a
// lower version, from the embedded archive of its architecture, else downloaded from their
// repository; either way the archive must be the one of the list (its sha256). A plugin the
// user removed (Lock.Declined), or installed from another repository, is left alone.
//
// Their permissions are granted (a decision of the user, docs/design/plugins.md): all of them
// on an install; on an upgrade, the ones granted before and those new in this version, so a
// permission the user revoked stays revoked.
//
// It answers the manifests installed; the errors of each plugin are given to logf, and the
// pod tries again at its next start.
func Ensure(ctx context.Context, in *install.Installer, src Source, logf func(format string, args ...any)) []plugins.Manifest {
	list, err := src.List()
	if err != nil {
		logf("plugins: %v", err)
		return nil
	}
	var out []plugins.Manifest
	for _, e := range list {
		m, err := ensure(ctx, in, src, e)
		if err != nil {
			logf("plugins: official %s %s: %v", e.ID, e.Version, err)
			continue
		}
		if m != nil {
			out = append(out, *m)
		}
	}
	return out
}

func ensure(ctx context.Context, in *install.Installer, src Source, e Entry) (*plugins.Manifest, error) {
	lock, err := install.ReadLock(in.Store)
	if err != nil {
		return nil, err
	}
	if slices.Contains(lock.Declined, e.ID) {
		return nil, nil
	}
	prev, had := lock.Plugins[e.ID]
	var before []string // the permissions of the installed version
	if had {
		if prev.URL != e.URL {
			return nil, fmt.Errorf("installed from %s, not the official %s: left alone", prev.URL, e.URL)
		}
		pv, err1 := install.ParseVersion(prev.Version)
		ev, err2 := install.ParseVersion(e.Version)
		if err1 == nil && err2 == nil && pv.Compare(ev) >= 0 {
			return nil, nil
		}
		if old, err := in.Manifest(e.ID, prev.Version); err == nil {
			before = old.Permissions
		}
	}
	arch := in.Architecture()
	data, ok, err := src.Archive(e, arch)
	if err != nil {
		return nil, err
	}
	if !ok {
		// A development build: the archive of the release, from the repository.
		cand, err := in.Resolve(ctx, e.URL, "="+e.Version)
		if err != nil {
			return nil, err
		}
		if data, err = in.Fetch(ctx, cand); err != nil {
			return nil, err
		}
		if err := Check(e, arch, data); err != nil {
			return nil, err
		}
	}
	grants := func(m plugins.Manifest) ([]string, error) {
		if m.ID != e.ID || m.Version != e.Version {
			return nil, fmt.Errorf("its archive holds %s %s", m.ID, m.Version)
		}
		if !had {
			return slices.Clone(m.Permissions), nil
		}
		var g []string
		for _, p := range m.Permissions {
			if slices.Contains(prev.Grants, p) || !slices.Contains(before, p) {
				g = append(g, p)
			}
		}
		return g, nil
	}
	_, m, err := in.InstallArchive(data, install.Locked{URL: e.URL, Constraint: e.Constraint, Official: true}, grants)
	if err != nil {
		return nil, err
	}
	return &m, nil
}
