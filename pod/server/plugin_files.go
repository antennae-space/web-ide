package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// pluginFilesPrefix is the route of the files of the external plugins (#208):
// /_plugins/<id>/<version>/index.js (the page module) and /_plugins/<id>/<version>/i18n.json (the
// catalogs of its languages). The version in the path makes them immutable: the Service Worker of
// the relay keeps them across loads and releases, where plugins.bundle carried them over the
// socket at every load.
const pluginFilesPrefix = "/_plugins/"

// pluginFile is one file of an external plugin, raw and gzipped (no brotli in Go's library).
type pluginFile struct {
	raw, gz []byte
	ctype   string
}

// servePluginFile answers a file of the installed version of an external plugin; any other id,
// version or name is not found, so no path of the disk is built from the request.
func (s *Server) servePluginFile(w http.ResponseWriter, r *http.Request) {
	id, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, pluginFilesPrefix), "/")
	version, name, _ := strings.Cut(rest, "/")
	e, ok := s.Plugins.External(id)
	if !ok || version != e.Version || (name != "index.js" && name != "i18n.json") {
		http.NotFound(w, r)
		return
	}
	files, err := s.pluginFiles(id, version)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	f := files[name]
	h := w.Header()
	h.Set("Content-Type", f.ctype)
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Add("Vary", "Accept-Encoding")
	body := f.raw
	if accepts(r.Header.Get("Accept-Encoding"), "gzip") && len(f.gz) < len(f.raw) {
		h.Set("Content-Encoding", "gzip")
		body = f.gz
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

// pluginFiles reads and compresses the files of a version once: a version installed never changes.
func (s *Server) pluginFiles(id, version string) (map[string]pluginFile, error) {
	key := id + "@" + version
	if v, ok := s.plugins.bundles.Load(key); ok {
		return v.(map[string]pluginFile), nil
	}
	got, js, catalogs, err := s.readBundle(id)
	if err != nil {
		return nil, err
	}
	cat, _ := json.Marshal(catalogs)
	files := map[string]pluginFile{
		"index.js":  {raw: js, gz: gzipped(js), ctype: "text/javascript; charset=utf-8"},
		"i18n.json": {raw: cat, gz: gzipped(cat), ctype: "application/json"},
	}
	// Installed meanwhile: the files read are of the new version, kept under it. The files of the
	// older versions go.
	s.plugins.bundles.Range(func(k, _ any) bool {
		if strings.HasPrefix(k.(string), id+"@") {
			s.plugins.bundles.Delete(k)
		}
		return true
	})
	s.plugins.bundles.Store(id+"@"+got, files)
	if got != version {
		return nil, errNotInstalled
	}
	return files, nil
}

var errNotInstalled = errors.New("this version of the plugin is not installed")

func gzipped(b []byte) []byte {
	var out bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&out, gzip.BestCompression)
	_, _ = zw.Write(b)
	_ = zw.Close()
	return out.Bytes()
}
