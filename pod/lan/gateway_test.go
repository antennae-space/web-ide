package lan

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGatewayRetriesIDEReadsAfterLANFailure(t *testing.T) {
	const prefix = PeerPrefix + "owner"
	var relayed string
	m := &Manager{
		cfg: Config{Remote: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			relayed = r.URL.RequestURI()
			w.WriteHeader(http.StatusNoContent)
		})},
		peers: map[string]*peer{"owner": {out: &link{addr: "stale.example:4436", serverFP: "pinned"}}},
		transports: map[string]*http.Transport{"pinned": {
			DialContext: func(context.Context, string, string) (net.Conn, error) {
				return nil, errors.New("stale LAN address")
			},
		}},
	}
	for _, tc := range []struct {
		method, target string
		want           int
	}{
		{"GET", "/project/demo?chat=abc&ticket=3", http.StatusNoContent},
		{"GET", "/ws", http.StatusNoContent},
		{"HEAD", "/assets/app.js", http.StatusNoContent},
		{"POST", "/project/demo", http.StatusBadGateway},
		{"GET", "/project/../open?path=/tmp/file", http.StatusBadGateway},
		{"GET", "/open?path=/tmp/file", http.StatusBadGateway},
	} {
		relayed = ""
		res := httptest.NewRecorder()
		m.ServeGateway(res, httptest.NewRequest(tc.method, prefix+tc.target, nil), "")
		if res.Code != tc.want {
			t.Errorf("%s %s: got %d, want %d", tc.method, tc.target, res.Code, tc.want)
		}
		if tc.want == http.StatusNoContent && relayed != prefix+tc.target {
			t.Errorf("relay received %q, want %q", relayed, prefix+tc.target)
		}
		if tc.want == http.StatusBadGateway && relayed != "" {
			t.Errorf("gateway replayed %s %s", tc.method, tc.target)
		}
	}
}
