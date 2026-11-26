package previews

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/lib/identity"
	"antennae.space/ide/plugins/previews/internal/preview"
	"antennae.space/ide/pod/plugins"
)

const (
	peerPreviewPath = "/_peer/previews/"
	linkLease       = 30 * time.Second
	linkRenew       = 10 * time.Second
	linkTimeout     = 5 * time.Second
)

type gatewayLinks struct {
	pod plugins.Pod
	pv  *preview.Manager

	openMu   sync.Mutex
	mu       sync.Mutex
	incoming map[linkKey]*gatewayListener
	outgoing map[string]string // preview ID to authorized gateway key
	stopped  bool
}

type linkKey struct{ source, preview string }

type gatewayListener struct {
	port     int
	server   *http.Server
	cancel   context.CancelFunc
	deadline time.Time
	timer    *time.Timer
}

func newGatewayLinks(pod plugins.Pod, pv *preview.Manager) *gatewayLinks {
	return &gatewayLinks{pod: pod, pv: pv, incoming: make(map[linkKey]*gatewayListener), outgoing: make(map[string]string)}
}

func (g *gatewayLinks) open(ctx context.Context, st preview.State, entry string) (preview.State, error) {
	own, gateway := g.pod.Gateway()
	if gateway == "" {
		gateway = entry
	}
	if !st.SavedServe || st.Console == "" || entry == "" || entry != gateway || own == gateway {
		return st, nil
	}
	_, life, ok := g.pv.PeerProxy(st.ID)
	if !ok {
		return st, i18n.New("The preview has closed.")
	}

	g.openMu.Lock()
	defer g.openMu.Unlock()
	if life.Err() != nil {
		return st, i18n.New("The preview has closed.")
	}
	port, err := g.request(ctx, gateway, st.ID, http.MethodPut)
	if err != nil {
		return st, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.outgoing[st.ID] != gateway {
		g.outgoing[st.ID] = gateway
		go g.maintain(life, gateway, st.ID)
	}
	st.GatewayURL = fmt.Sprintf("http://127.0.0.1:%d/", port)
	return st, nil
}

func (g *gatewayLinks) request(ctx context.Context, gateway, id, method string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, "http://"+gateway+peerPreviewPath+"link/"+id, nil)
	if err != nil {
		return 0, err
	}
	resp, err := g.pod.Peers().Transport().RoundTrip(req)
	if err != nil {
		return 0, i18n.Errorf("Could not open the preview on the Gateway: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent && method != http.MethodPut {
		return 0, nil
	}
	if resp.StatusCode == http.StatusOK && method == http.MethodPut {
		var port int
		if err := json.NewDecoder(io.LimitReader(resp.Body, 128)).Decode(&port); err == nil && port > 0 && port <= 65535 {
			return port, nil
		}
	}
	return 0, i18n.Errorf("Could not open the preview on the Gateway: %v", resp.Status)
}

func (g *gatewayLinks) maintain(life context.Context, gateway, id string) {
	ticker := time.NewTicker(linkRenew)
	defer ticker.Stop()
	defer func() {
		g.mu.Lock()
		if g.outgoing[id] == gateway {
			delete(g.outgoing, id)
		}
		g.mu.Unlock()
		_, _ = g.request(context.Background(), gateway, id, http.MethodDelete)
	}()

	for {
		select {
		case <-life.Done():
			return
		case <-ticker.C:
			_, elected := g.pod.Gateway()
			if elected != "" && elected != gateway {
				return
			}
			// Renewal only extends an existing lease. An open after a gateway restart
			// creates a new listener and returns its new port.
			_, _ = g.request(life, gateway, id, http.MethodPatch)
		}
	}
}

func (g *gatewayLinks) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	peer := identity.PeerOf(r.Context())
	if peer == nil || peer.Kind != identity.KindPod {
		http.Error(w, "for the pods of the account only", http.StatusForbidden)
		return
	}
	kind, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	id, _, _ := strings.Cut(rest, "/")
	if _, err := hex.DecodeString(id); len(id) != 32 || err != nil {
		http.NotFound(w, r)
		return
	}
	switch kind {
	case "link":
		if rest == id {
			g.control(w, r, linkKey{peer.Key, id})
			return
		}
	case "app":
		g.mu.Lock()
		gateway := g.outgoing[id]
		g.mu.Unlock()
		_, elected := g.pod.Gateway()
		if gateway == "" || gateway != peer.Key || (elected != "" && gateway != elected) {
			http.Error(w, "preview link refused", http.StatusForbidden)
			return
		}
		if proxy, life, ok := g.pv.PeerProxy(id); ok {
			ctx, cancel := context.WithCancel(r.Context())
			defer cancel()
			stop := context.AfterFunc(life, cancel)
			defer stop()
			http.StripPrefix("/app/"+id, proxy).ServeHTTP(w, r.WithContext(ctx))
			return
		}
	}
	http.NotFound(w, r)
}

func (g *gatewayLinks) control(w http.ResponseWriter, r *http.Request, key linkKey) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stopped {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if r.Method == http.MethodDelete {
		g.remove(key)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	own, elected := g.pod.Gateway()
	if own == "" || own != elected {
		w.WriteHeader(http.StatusForbidden)
		return
	}

	link := g.incoming[key]
	switch r.Method {
	case http.MethodPut:
		if link == nil {
			var err error
			link, err = g.listen(key)
			if err != nil {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
		}
		link.deadline = time.Now().Add(linkLease)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(link.port)
	case http.MethodPatch:
		if link == nil {
			http.NotFound(w, r)
			return
		}
		link.deadline = time.Now().Add(linkLease)
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// listen runs under mu. Its base context also closes upgraded connections on removal.
func (g *gatewayLinks) listen(key linkKey) (*gatewayListener, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	target := &url.URL{Scheme: "http", Host: key.source, Path: peerPreviewPath + "app/" + key.preview}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Header.Del("Cookie")
			for _, cookie := range pr.In.Cookies() {
				if cookie.Name != "webide_token" {
					pr.Out.AddCookie(cookie)
				}
			}
		},
		ModifyResponse: func(resp *http.Response) error {
			cookies := resp.Header.Values("Set-Cookie")
			resp.Header.Del("Set-Cookie")
			for _, value := range cookies {
				cookie, err := http.ParseSetCookie(value)
				if err != nil || cookie.Name != "webide_token" {
					resp.Header.Add("Set-Cookie", value)
				}
			}
			return nil
		},
		Transport:     g.pod.Peers().Transport(),
		FlushInterval: -1,
	}
	port := listener.Addr().(*net.TCPAddr).Port
	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Match the host and IDE cookie of a private local preview.
			host := strconv.Itoa(port)
			if (r.Host != "127.0.0.1:"+host && r.Host != "localhost:"+host) || !g.pod.Authorized(r) {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			proxy.ServeHTTP(w, r)
		}),
		BaseContext:       func(net.Listener) context.Context { return ctx },
		ReadHeaderTimeout: 30 * time.Second,
	}
	link := &gatewayListener{port: port, server: server, cancel: cancel}
	link.timer = time.AfterFunc(linkLease, func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		if g.incoming[key] != link {
			return
		}
		if remaining := time.Until(link.deadline); remaining > 0 {
			link.timer.Reset(remaining)
			return
		}
		g.remove(key)
	})
	g.incoming[key] = link
	go func() { _ = server.Serve(listener) }()
	return link, nil
}

func (g *gatewayLinks) remove(key linkKey) {
	if link := g.incoming[key]; link != nil {
		delete(g.incoming, key)
		link.timer.Stop()
		link.cancel()
		_ = link.server.Close()
	}
}

func (g *gatewayLinks) stop() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.stopped = true
	for key := range g.incoming {
		g.remove(key)
	}
}
