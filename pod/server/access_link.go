package server

import (
	"html/template"
	"net/http"
	"net/url"
	"path"
	"strings"

	"antennae.space/ide/lib/i18n"
)

const accessContinuePath = "/auth/continue"

var accessLinkPage = template.Must(template.New("access-link").Parse(`<!doctype html>
<html lang="{{.Lang}}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{{if .Automatic}}<meta http-equiv="refresh" content="0;url={{.Continue}}">{{end}}
<title>Web IDE</title>
<a href="{{.Continue}}">{{.T "Open"}}</a>
</html>`))

// accessLinkTarget accepts app pages and file links on the pod or a local gateway.
// A file link can change an existing window, so it needs a click to continue.
func accessLinkTarget(raw string) (target string, automatic bool) {
	next := accessNext(raw)
	u, err := url.ParseRequestURI(next)
	if err != nil || path.Clean(u.Path) != strings.TrimSuffix(u.Path, "/") {
		return "", false
	}
	p := u.Path
	if peer, ok := strings.CutPrefix(p, peerPrefix); ok {
		key, rest, ok := strings.Cut(peer, "/")
		if !ok || !basePattern.MatchString(peerPrefix+key) {
			return "", false
		}
		p = "/" + rest
	}
	if p == openPath {
		return next, false
	}
	if id, ok := strings.CutPrefix(p, "/project/"); ok && id != "" {
		return next, true
	}
	return "", false
}

// A cross-site navigation withholds the Strict cookie. Commit a small document
// on this origin so the next navigation can send the browser's existing cookie.
func showAccessLink(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet || !loopback(r) || r.Header.Get("Sec-Fetch-Site") != "cross-site" ||
		r.Header.Get("Sec-Fetch-Mode") != "navigate" || r.Header.Get("Sec-Fetch-Dest") != "document" {
		return false
	}
	target, automatic := accessLinkTarget(r.URL.RequestURI())
	if target == "" {
		return false
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	_ = accessLinkPage.Execute(w, struct {
		tokenView
		Continue  string
		Automatic bool
	}{
		tokenView: tokenView{Lang: i18n.Detect(r.Header.Get("Accept-Language"))},
		Continue:  accessContinuePath + "?next=" + url.QueryEscape(target),
		Automatic: automatic,
	})
	return true
}

func (s *Server) continueAccess(w http.ResponseWriter, r *http.Request) {
	target, _ := accessLinkTarget(r.URL.Query().Get("next"))
	if target == "" || !loopback(r) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if s.authorized(r) {
		http.Redirect(w, r, target, http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	showAccessToken(w, r, "", target)
}
