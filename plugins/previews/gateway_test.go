package previews

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"antennae.space/ide/lib/identity"
	"antennae.space/ide/plugins/previews/internal/preview"
	"antennae.space/ide/pod/plugins"
)

type previewLinkPod struct {
	plugins.Pod
}

func (previewLinkPod) Gateway() (string, string) { return "source", "gateway" }

func TestGatewayPreviewUsesProjectDial(t *testing.T) {
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s %s", r.Host, r.URL.RequestURI())
	}))
	defer app.Close()

	pv := preview.New(nil, nil, nil)
	defer pv.Shutdown()
	var dialer net.Dialer
	st, err := pv.Start(preview.Spec{AppPort: 5173, SavedServe: true}, "console", func(ctx context.Context, network, addr string) (net.Conn, error) {
		if addr != "127.0.0.1:5173" {
			return nil, fmt.Errorf("unexpected app address: %s", addr)
		}
		return dialer.DialContext(ctx, network, app.Listener.Addr().String())
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	g := newGatewayLinks(previewLinkPod{}, pv)
	g.outgoing[st.ID] = "gateway"

	get := func(key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/app/"+st.ID+"/example?q=abc", nil)
		ctx := identity.WithPeer(req.Context(), &identity.Cert{Kind: identity.KindPod, Key: key})
		rec := httptest.NewRecorder()
		g.ServeHTTP(rec, req.WithContext(ctx))
		return rec
	}
	if rec := get("another-pod"); rec.Code != http.StatusForbidden {
		t.Fatalf("other pod got HTTP %d", rec.Code)
	}
	if rec := get("gateway"); rec.Code != http.StatusOK || rec.Body.String() != "localhost:5173 /example?q=abc" {
		t.Fatalf("gateway got HTTP %d: %s", rec.Code, rec.Body)
	}
	pv.Close(st.ID)
	if rec := get("gateway"); rec.Code != http.StatusNotFound {
		t.Fatalf("closed preview returned HTTP %d", rec.Code)
	}
}

type gatewayListenerPod struct{ plugins.Pod }
type gatewayListenerPeers struct{ plugins.Peers }

func (gatewayListenerPod) Gateway() (string, string)      { return "gateway", "gateway" }
func (gatewayListenerPod) Peers() plugins.Peers           { return gatewayListenerPeers{} }
func (gatewayListenerPeers) Transport() http.RoundTripper { return http.DefaultTransport }

func TestGatewayPreviewLeaseExpires(t *testing.T) {
	g := newGatewayLinks(gatewayListenerPod{}, nil)
	defer g.stop()
	key := linkKey{"source", "preview"}
	control := func(method string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		g.control(rec, httptest.NewRequest(method, "/", nil), key)
		return rec
	}
	if rec := control(http.MethodPut); rec.Code != http.StatusOK {
		t.Fatalf("opening returned HTTP %d", rec.Code)
	}
	if rec := control(http.MethodPatch); rec.Code != http.StatusNoContent {
		t.Fatalf("renewing returned HTTP %d", rec.Code)
	}

	g.mu.Lock()
	link := g.incoming[key]
	link.deadline = time.Now()
	link.timer.Reset(0)
	g.mu.Unlock()

	end := time.Now().Add(time.Second)
	for time.Now().Before(end) {
		g.mu.Lock()
		expired := g.incoming[key] == nil
		g.mu.Unlock()
		if expired {
			if rec := control(http.MethodPatch); rec.Code != http.StatusNotFound {
				t.Fatalf("renewal recreated an expired link: HTTP %d", rec.Code)
			}
			conn, err := net.Dial("tcp4", fmt.Sprintf("127.0.0.1:%d", link.port))
			if err == nil {
				_ = conn.Close()
				t.Fatal("the expired listener still accepts connections")
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("the link did not expire")
}
