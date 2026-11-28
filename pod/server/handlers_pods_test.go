package server

import (
	"context"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"antennae.space/ide/lib/identity"
	"antennae.space/ide/lib/tunnel"
)

// fakePods records the power requests the handler passes on, and signs as a pod would.
type fakePods struct {
	got     []*identity.PowerRequest
	gateway string
	podIDs  map[string]string
}

func (f *fakePods) List() any                    { return nil }
func (f *fakePods) Preferred() bool              { return false }
func (f *fakePods) SetPreferred(on bool) error   { return nil }
func (f *fakePods) Gateway() string              { return f.gateway }
func (f *fakePods) Cluster() string              { return "" }
func (f *fakePods) Own() string                  { return "own" }
func (f *fakePods) RelayPodID(key string) string { return f.podIDs[key] }
func (f *fakePods) CanUpdate() bool              { return false }
func (f *fakePods) CanPower() bool               { return false }
func (f *fakePods) Update(ctx context.Context, req *identity.UpdateRequest) (any, error) {
	return nil, nil
}
func (f *fakePods) Power(ctx context.Context, req *identity.PowerRequest) (any, error) {
	f.got = append(f.got, req)
	return map[string]any{"status": "running"}, nil
}
func (f *fakePods) SignPower(req *identity.PowerRequest) error {
	req.Sig = "signed-by-the-pod"
	return nil
}

// TestPowerLocal: a window on the WebSocket of the pod (LAN, 127.0.0.1) asks a power action
// without the passkey and the pod signs it; a window of the relay must sign it itself, and its
// own signature is carried untouched.
func TestPowerLocal(t *testing.T) {
	s, ts := newServer(t)
	pods := &fakePods{}
	s.Pods = pods
	a, err := dial(t, ts, s.Token)
	if err != nil {
		t.Fatal(err)
	}
	if self := a.call("pods.self", nil)["result"].(map[string]any); self["local"] != true {
		t.Fatalf("a window on the WebSocket of the pod is local: %v", self)
	}
	a.call("pods.power", map[string]any{"pod": "bravo", "action": "restart"})
	if len(pods.got) != 1 || pods.got[0].Sig != "signed-by-the-pod" {
		t.Fatalf("the pod signs the request of a local window: %+v", pods.got)
	}

	p := newMsgPipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.ServeTunnel(ctx, p.server, make(chan tunnel.LabeledConn))
	if self := p.call(t, 1, "pods.self", nil)["result"].(map[string]any); self["local"] != false {
		t.Fatalf("a window of the relay is not local: %v", self)
	}
	if r := p.call(t, 2, "pods.power", map[string]any{"pod": "bravo", "action": "shutdown"}); r["error"] == nil {
		t.Fatalf("an unsigned request of a window of the relay is refused: %v", r)
	}
	if len(pods.got) != 1 {
		t.Fatalf("the refused request reached the pods: %+v", pods.got)
	}
	p.call(t, 3, "pods.power", map[string]any{"pod": "bravo", "action": "shutdown", "sig": "signed-by-the-browser"})
	if len(pods.got) != 2 || pods.got[1].Sig != "signed-by-the-browser" {
		t.Fatalf("the signature of the browser is carried: %+v", pods.got)
	}
}

// TestRelayLinks: a paired pod with a relay gives Claude Code its page on the relay origin, and
// the local address beside it; /open asked through the tunnel sends the frame to the project page
// under the path of the pod.
func TestRelayLinks(t *testing.T) {
	s, ts := newServer(t)
	s.Cfg.Addr = "127.0.0.1:4433"
	pods := &fakePods{gateway: "gateway-key", podIDs: map[string]string{"gateway-key": "gateway-registration"}}
	s.Pods = pods
	state := "connected"
	s.RelayStatus = func() RelayInfo { return RelayInfo{URL: "wss://relay.example", State: state} }
	text := s.mcpInstructions(mcpIdentity{mcpGrant: mcpGrant{Profile: mcpDeveloper}})
	local := "http://localhost:4433/_lan/pod/own"
	if !strings.Contains(text, local+"/open?path=") {
		t.Errorf("missing local owner route in instructions: %s", text)
	}
	path := "/project/root?chat=abc&other=a%2Bb"
	public, gotLocal := s.resourceScope().ResourceURLs(path)
	u, err := url.Parse(public)
	if err != nil {
		t.Fatal(err)
	}
	f, err := url.ParseQuery(u.EscapedFragment())
	if err != nil || u.Host != "relay.example" || f.Get("pod") != "gateway-registration" ||
		f.Get("open") != "/pod/own"+path || gotLocal != local+path {
		t.Fatalf("relay and local resources: %q %q (%v)", public, gotLocal, err)
	}
	state = "connecting"
	if public, _ := s.resourceScope().ResourceURLs(path); public != "" {
		t.Fatalf("a connecting relay supplied a link: %s", public)
	}
	state = "connected"
	delete(pods.podIDs, "gateway-key")
	if public, _ := s.resourceScope().ResourceURLs(path); public != "" {
		t.Fatalf("an unregistered relay supplied a link: %s", public)
	}
	pods.podIDs["own"] = "direct-registration"
	if public, _ := s.resourceScope().ResourceURLs(path); !strings.Contains(public, "pod=direct-registration") {
		t.Fatalf("registered owner fallback: %s", public)
	}
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/_lan/pod/own"+path, nil)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: s.Token})
	hc := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != path {
		t.Fatalf("local owner route: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}

	a, _ := dial(t, ts, s.Token)
	dir := t.TempDir()
	id := a.call("projects.create", map[string]any{"type": "local", "path": dir})["result"].(map[string]any)["id"].(string)
	p := newMsgPipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	chans := make(chan tunnel.LabeledConn, 1)
	go s.ServeTunnel(ctx, p.server, chans)
	file := filepath.Join(dir, "a.go")
	head, _ := httpChan(t, chans, 1, map[string]any{"path": "/open?path=" + url.QueryEscape(file) + "&line=3", "base": "/pod/own", "method": "GET"})
	hs, _ := head["headers"].(map[string]any)
	want := "/pod/own/project/" + url.PathEscape(id) + "?open=" + url.QueryEscape(file+":3")
	if head["status"] != float64(302) || hs["Location"] != want {
		t.Fatalf("/open through the tunnel: %v (want %s)", head, want)
	}
}
