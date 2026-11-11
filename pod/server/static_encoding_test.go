package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"antennae.space/ide/lib/tunnel"
)

// encodedFS is a built front end with an asset and its precompressed variants (compress.mjs).
func encodedFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":       {Data: []byte(`<script src="./assets/app.js"></script>`)},
		"assets/app.js":    {Data: []byte("console.log('raw')")},
		"assets/app.js.br": {Data: []byte("BROTLI")},
		"assets/app.js.gz": {Data: []byte("GZIP")},
		"assets/only.css":  {Data: []byte("body{}")},
	}
}

// The pod answers an asset with its precompressed variant along Accept-Encoding, brotli first,
// with the Content-Type of the asset; a range request and a refused coding get the raw file.
func TestServeStaticEncoded(t *testing.T) {
	s := &Server{Static: encodedFS()}
	get := func(p string, h map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, p, nil)
		for k, v := range h {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		s.serveStatic(w, r)
		return w
	}
	cases := []struct {
		accept, rng, enc, body string
	}{
		{"gzip, deflate, br", "", "br", "BROTLI"},
		{"gzip", "", "gzip", "GZIP"},
		{"br;q=0, gzip", "", "gzip", "GZIP"},
		{"*", "", "br", "BROTLI"},
		{"*, br;q=0", "", "gzip", "GZIP"},
		{"", "", "", "console.log('raw')"},
		{"identity", "", "", "console.log('raw')"},
		{"br", "bytes=0-6", "", "console"},
	}
	for _, c := range cases {
		w := get("/assets/app.js", map[string]string{"Accept-Encoding": c.accept, "Range": c.rng})
		if got := w.Header().Get("Content-Encoding"); got != c.enc || w.Body.String() != c.body {
			t.Errorf("accept %q range %q: encoding %q body %q", c.accept, c.rng, got, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); ct != "text/javascript; charset=utf-8" {
			t.Errorf("accept %q: Content-Type %q", c.accept, ct)
		}
		if w.Header().Get("Vary") != "Accept-Encoding" {
			t.Errorf("accept %q: Vary %q", c.accept, w.Header().Get("Vary"))
		}
		if w.Header().Get("Cache-Control") == "" {
			t.Errorf("accept %q: no Cache-Control", c.accept)
		}
	}
	// An asset without variants, and the page, are raw.
	if w := get("/assets/only.css", map[string]string{"Accept-Encoding": "br, gzip"}); w.Header().Get("Content-Encoding") != "" || w.Body.String() != "body{}" {
		t.Errorf("asset without variants: %q %q", w.Header().Get("Content-Encoding"), w.Body.String())
	}
	if w := get("/project/x", map[string]string{"Accept-Encoding": "br, gzip"}); w.Header().Get("Content-Encoding") != "" {
		t.Errorf("page: Content-Encoding %q", w.Header().Get("Content-Encoding"))
	}
}

// Through the tunnel, the pod compresses only for a Service Worker that decodes itself
// (DecodeHeader): an older one would give the page a compressed body.
func TestTunnelHTTPEncoded(t *testing.T) {
	s, _ := newServer(t)
	s.Static = encodedFS()
	p := newMsgPipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	chans := make(chan tunnel.LabeledConn, 4)
	go s.ServeTunnel(ctx, p.server, chans)

	head, body := httpChan(t, chans, 1, map[string]any{"path": "/assets/app.js", "headers": map[string]string{"accept-encoding": "gzip, br"}})
	if h := head["headers"].(map[string]any); h["Content-Encoding"] != nil || body != "console.log('raw')" {
		t.Fatalf("without the marker: %v %q", h, body)
	}
	head, body = httpChan(t, chans, 2, map[string]any{"path": "/assets/app.js", "headers": map[string]string{"accept-encoding": "gzip", "x-webide-decode": "1"}})
	if h := head["headers"].(map[string]any); h["Content-Encoding"] != "gzip" || body != "GZIP" {
		t.Fatalf("with the marker: %v %q", h, body)
	}
}
