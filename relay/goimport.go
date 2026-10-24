package relay

import (
	"html"
	"net/http"
	"strings"
)

// The Go modules of the antennae-space organisation, by their first path element under
// antennae.space: names of the hosted relay rather than of GitHub, so a repository may move and
// its import path stays.
var goModules = map[string]string{
	"ide":        "https://github.com/antennae-space/web-ide",
	"plugin-sdk": "https://github.com/antennae-space/plugin-sdk",
}

// serveGoImport answers `go get antennae.space/<module>/...` (`?go-get=1`) with the go-import
// and go-source tags naming its repository; a browser is sent to the repository itself.
func serveGoImport(w http.ResponseWriter, r *http.Request) {
	name, _, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	repo, ok := goModules[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	if r.URL.Query().Get("go-get") != "1" {
		http.Redirect(w, r, repo, http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	module := "antennae.space/" + name
	repo = html.EscapeString(repo)
	_, _ = w.Write([]byte(`<!doctype html><meta name="go-import" content="` + module + ` git ` + repo + `">` +
		`<meta name="go-source" content="` + module + ` ` + repo + ` ` + repo + `/tree/main{/dir} ` + repo + `/blob/main{/dir}/{file}#L{line}">`))
}
