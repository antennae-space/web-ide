package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"

	"github.com/coder/websocket"
)

// countingListener counts the bytes the server writes on its connections.
type countingListener struct {
	net.Listener
	written *atomic.Int64
}

func (l countingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return countingConn{c, l.written}, nil
}

type countingConn struct {
	net.Conn
	written *atomic.Int64
}

func (c countingConn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	c.written.Add(int64(n))
	return n, err
}

// The app socket negotiates permessage-deflate (#210): a large answer carries far fewer bytes on
// the wire, and a client without the extension still gets it raw.
func TestAppSocketCompressed(t *testing.T) {
	page := "# A page\n\n" + strings.Repeat("The JSON of the file lists, the conversations and the diffs compresses well.\n", 400)
	s, _ := newServerWith(t, func(s *Server) { s.Docs = fstest.MapFS{"docs/page.md": {Data: []byte(page)}} })
	var written atomic.Int64
	ts := httptest.NewUnstartedServer(s)
	ts.Listener = countingListener{ts.Listener, &written}
	ts.Start()
	defer ts.Close()

	wire := func(mode websocket.CompressionMode) (int64, int, string) {
		h := http.Header{}
		h.Set("Cookie", cookieName+"="+s.Token)
		h.Set("Origin", ts.URL)
		c, res, err := websocket.Dial(context.Background(), strings.Replace(ts.URL, "http", "ws", 1)+"/ws", &websocket.DialOptions{HTTPHeader: h, CompressionMode: mode})
		if err != nil {
			t.Fatal(err)
		}
		defer c.CloseNow()
		c.SetReadLimit(64 << 20)
		before := written.Load()
		_ = c.Write(context.Background(), websocket.MessageText, []byte(`{"id":1,"method":"docs.read","params":{"path":"docs/page.md"}}`))
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			var m map[string]any
			if json.Unmarshal(data, &m) == nil && m["id"] == float64(1) {
				if m["error"] != nil {
					t.Fatalf("docs.read: %v", m["error"])
				}
				return written.Load() - before, len(data), res.Header.Get("Sec-WebSocket-Extensions")
			}
		}
	}
	raw, size, ext := wire(websocket.CompressionDisabled)
	if ext != "" || raw < int64(size) {
		t.Fatalf("without the extension: %q, %d bytes on the wire for %d", ext, raw, size)
	}
	packed, _, ext := wire(websocket.CompressionNoContextTakeover)
	if !strings.Contains(ext, "permessage-deflate") || packed*2 > raw {
		t.Fatalf("with the extension: %q, %d bytes on the wire, %d raw", ext, packed, raw)
	}
	t.Logf("docs.read: %d bytes raw, %d compressed", raw, packed)
}
