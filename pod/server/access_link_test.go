package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestAccessLinkContinuation(t *testing.T) {
	s, _ := newServer(t)
	const target = "/_lan/pod/peer/project/demo?chat=fixture&ticket=42"
	const fileLink = "/_lan/pod/peer/open?line=3&path=%2Ftmp%2Ffile"
	const external = "cross-site"
	request := func(method, path, site, dest string, authed bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "http://localhost:4433"+path, nil)
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Sec-Fetch-Site", site)
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Sec-Fetch-Dest", dest)
		if authed {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: s.Token})
		}
		res := httptest.NewRecorder()
		s.ServeHTTP(res, req)
		return res
	}
	res := request("GET", target, external, "document", false)
	if res.Code != http.StatusOK || res.Header().Get("Cache-Control") != "no-store" ||
		!strings.Contains(res.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") ||
		!strings.Contains(res.Body.String(), `http-equiv="refresh"`) ||
		!strings.Contains(res.Body.String(), url.QueryEscape(target)) ||
		strings.Contains(res.Body.String(), "assets/app.js") || res.Header().Get("Set-Cookie") != "" {
		t.Fatalf("cross-site document returned %d %v %s", res.Code, res.Header(), res.Body)
	}
	res = request("GET", fileLink, external, "document", false)
	if res.Code != http.StatusOK || strings.Contains(res.Body.String(), `http-equiv="refresh"`) ||
		!strings.Contains(res.Body.String(), url.QueryEscape(fileLink)) {
		t.Fatalf("file link must wait for a click: %d %s", res.Code, res.Body)
	}
	cont := accessContinuePath + "?next=" + url.QueryEscape(target)
	res = request("GET", cont, "same-origin", "document", true)
	if res.Code != http.StatusFound || res.Header().Get("Location") != target || res.Header().Get("Set-Cookie") != "" {
		t.Fatalf("authenticated continuation: %d %v", res.Code, res.Header())
	}
	res = request("GET", cont, "same-origin", "document", false)
	if res.Code != http.StatusUnauthorized || !strings.Contains(res.Body.String(), `name="token"`) ||
		!strings.Contains(res.Body.String(), strings.ReplaceAll(target, "&", "&amp;")) {
		t.Fatalf("continuation without a session: %d %s", res.Code, res.Body)
	}
	for _, bad := range []string{"https://outside.example/project/demo", "//outside.example/project/demo", "/ws",
		"/_lan/pod/peer/project/../ws", "/_lan/pod/peer/_peer/anything"} {
		res = request("GET", accessContinuePath+"?next="+url.QueryEscape(bad), "same-origin", "document", true)
		if res.Code != http.StatusNotFound {
			t.Errorf("invalid continuation %q: %d", bad, res.Code)
		}
	}
	if res = request("GET", target, external, "iframe", false); res.Code != http.StatusUnauthorized {
		t.Errorf("iframe got a continuation: %d", res.Code)
	}
	if res = request("GET", "/ws", external, "document", false); res.Code != http.StatusUnauthorized {
		t.Errorf("WebSocket got a continuation: %d", res.Code)
	}
	if res = request("POST", target, external, "document", false); res.Code != http.StatusUnauthorized {
		t.Errorf("POST got a continuation: %d", res.Code)
	}
}
