package server

import (
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// DecodeHeader marks a fetch whose sender decodes a Content-Encoding itself: the Service Worker of
// the relay, which builds the Response of the page (a browser never decodes one built there). A
// fetch through the tunnel without it gets raw bytes, whatever its Accept-Encoding says: an older
// Service Worker would hand a compressed body to the page undecoded (#207).
const DecodeHeader = "X-Webide-Decode"

// encodings are the precompressed variants written next to the assets at build
// (web/scripts/compress.mjs), the preferred first.
var encodings = []struct{ name, ext string }{{"br", ".br"}, {"gzip", ".gz"}}

// serveEncoded answers the file p with its precompressed variant when the request accepts one,
// with the Content-Type of p itself. A range request gets the raw file: its offsets are those of
// the decoded bytes.
func (s *Server) serveEncoded(w http.ResponseWriter, r *http.Request, p string) bool {
	w.Header().Add("Vary", "Accept-Encoding")
	if r.Header.Get("Range") != "" {
		return false
	}
	accept := r.Header.Get("Accept-Encoding")
	for _, e := range encodings {
		if !accepts(accept, e.name) {
			continue
		}
		f, err := s.Static.Open(p + e.ext)
		if err != nil {
			continue
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || st.IsDir() {
			continue
		}
		h := w.Header()
		if h.Get("Content-Type") == "" {
			ctype := mime.TypeByExtension(path.Ext(p))
			if ctype == "" {
				ctype = "application/octet-stream"
			}
			h.Set("Content-Type", ctype)
		}
		h.Set("Content-Encoding", e.name)
		h.Set("Content-Length", strconv.FormatInt(st.Size(), 10))
		if r.Method == http.MethodHead {
			return true
		}
		_, _ = io.Copy(w, f)
		return true
	}
	return false
}

// accepts tells whether an Accept-Encoding header takes the coding name: listed, or under *,
// and not with q=0.
func accepts(header, name string) bool {
	star := false
	for part := range strings.SplitSeq(header, ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		coding = strings.ToLower(strings.TrimSpace(coding))
		if coding != name && coding != "*" {
			continue
		}
		ok := true
		for p := range strings.SplitSeq(params, ";") {
			k, v, _ := strings.Cut(strings.TrimSpace(p), "=")
			if strings.EqualFold(k, "q") {
				if q, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && q == 0 {
					ok = false
				}
			}
		}
		if coding == name {
			return ok
		}
		star = ok
	}
	return star
}
