package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"antennae.space/ide/pod/plugins/install"
)

// The external plugins of the lock join the registry when the pod starts; one whose folder is
// gone is left out.
func TestExternalsAtStart(t *testing.T) {
	s, ts := newServerWith(t, func(s *Server) {
		manifest := `{"id": "greet", "name": "Greet", "version": "1.0.0", "apiVersion": 1, "permissions": ["files:read", "net"], "assets": "https://x/{version}/{arch}.tar.gz", "contributes": {}}`
		dir := s.Store.Path("plugins", "greet", "1.0.0")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(manifest), 0o600)
		os.MkdirAll(filepath.Join(dir, "web"), 0o700)
		os.MkdirAll(filepath.Join(dir, "i18n"), 0o700)
		os.WriteFile(filepath.Join(dir, "web", "index.js"), []byte("ide.register({})"), 0o600)
		os.WriteFile(filepath.Join(dir, "i18n", "fr.json"), []byte(`{"Hello": "Bonjour"}`), 0o600)
		_ = install.WriteLock(s.Store, install.Lock{Plugins: map[string]install.Locked{
			"greet": {URL: "https://example.test/greet", Version: "1.0.0", SHA256: "x", Grants: []string{}},
			"gone":  {URL: "https://example.test/gone", Version: "1.0.0"},
		}})
	})
	e, ok := s.Plugins.External("greet")
	if !ok || e.Version != "1.0.0" || e.URL != "https://example.test/greet" || e.Manifest.Name != "Greet" {
		t.Fatalf("greet: %+v %v", e, ok)
	}
	if _, ok := s.Plugins.External("gone"); ok {
		t.Fatal("a plugin without its folder is left out")
	}

	// Its page module and its catalogs, for the sandboxed frames of the page.
	b, err := s.pluginBundle("greet")
	m, _ := b.(map[string]any)
	if err != nil || m["js"] != "ide.register({})" || m["catalogs"].(map[string]map[string]string)["fr"]["Hello"] != "Bonjour" {
		t.Fatalf("bundle: %v %v", b, err)
	}
	if _, err := s.pluginBundle("gone"); err == nil {
		t.Fatal("not installed")
	}
	// The same files over HTTP (#208), at the path of the installed version, immutable, for a
	// paired window only.
	get := func(path string, cookie bool) (*http.Response, string) {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+path, nil)
		if cookie {
			req.Header.Set("Cookie", cookieName+"="+s.Token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res, string(body)
	}
	if res, body := get("/_plugins/greet/1.0.0/index.js", true); res.StatusCode != 200 || body != "ide.register({})" || !strings.Contains(res.Header.Get("Cache-Control"), "immutable") || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/javascript") {
		t.Fatalf("index.js: %d %q %v", res.StatusCode, body, res.Header)
	}
	if res, body := get("/_plugins/greet/1.0.0/i18n.json", true); res.StatusCode != 200 || body != `{"fr":{"Hello":"Bonjour"}}` {
		t.Fatalf("i18n.json: %d %q", res.StatusCode, body)
	}
	for _, p := range []string{"/_plugins/greet/0.9.0/index.js", "/_plugins/gone/1.0.0/index.js", "/_plugins/greet/1.0.0/plugin.json", "/_plugins/greet/1.0.0/../1.0.0/web/index.js"} {
		if res, _ := get(p, true); res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %d", p, res.StatusCode)
		}
	}
	if res, _ := get("/_plugins/greet/1.0.0/index.js", false); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("without the cookie: %d", res.StatusCode)
	}
	// Big enough to compress: gzipped for a browser that takes it.
	big := []byte("ide.register({})" + strings.Repeat("\n// a comment that compresses", 200))
	os.WriteFile(filepath.Join(s.Store.Path("plugins", "greet", "1.0.0"), "web", "index.js"), big, 0o600)
	s.plugins.bundles.Clear()
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/_plugins/greet/1.0.0/index.js", nil)
	req.Header.Set("Cookie", cookieName+"="+s.Token)
	req.Header.Set("Accept-Encoding", "gzip")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(res.Body)
	if err != nil || res.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("gzip: %v %v", err, res.Header)
	}
	if got, _ := io.ReadAll(zr); string(got) != string(big) {
		t.Fatal("gzip: another body")
	}
	res.Body.Close()

	// Its grants, changed in Settings: a permission it does not ask is refused; the lock follows.
	a, _ := dial(t, ts, s.Token)
	if r := a.callRaw("plugins.grants", map[string]any{"id": "greet", "grants": []string{"exec"}}); r["error"] == nil {
		t.Fatal("a permission it does not ask")
	}
	a.call("plugins.grants", map[string]any{"id": "greet", "grants": []string{"net"}})
	lock, _ := install.ReadLock(s.Store)
	if e, _ := s.Plugins.External("greet"); len(e.Grants) != 1 || e.Grants[0] != "net" || lock.Plugins["greet"].Grants[0] != "net" {
		t.Fatalf("grants: %v %v", e.Grants, lock.Plugins["greet"].Grants)
	}
	if h := a.call("plugins.host", nil)["result"].(map[string]any); h["landlock"] == nil {
		t.Fatal("plugins.host")
	}
}
