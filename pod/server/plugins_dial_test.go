package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"antennae.space/ide/pod/plugins"
)

// receiveFD is what a backend does with fd 3: take the socket sent with an id.
func receiveFD(t *testing.T, theirs *os.File, id int) net.Conn {
	t.Helper()
	c, err := net.FileConn(theirs)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	buf, oob := make([]byte, 32), make([]byte, syscall.CmsgSpace(4))
	n, oobn, _, _, err := c.(*net.UnixConn).ReadMsgUnix(buf, oob)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := strconv.Atoi(string(buf[:n])); got != id {
		t.Fatalf("id %d, want %d", got, id)
	}
	msgs, _ := syscall.ParseSocketControlMessage(oob[:oobn])
	fds, err := syscall.ParseUnixRights(&msgs[0])
	if err != nil || len(fds) != 1 {
		t.Fatalf("rights: %v", err)
	}
	f := os.NewFile(uintptr(fds[0]), "conn")
	defer f.Close()
	conn, err := net.FileConn(f)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func lineEcho(t *testing.T) net.Listener {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); r := bufio.NewReader(c); l, _ := r.ReadString('\n'); fmt.Fprint(c, "echo "+l) }()
		}
	}()
	return l
}

func pingThrough(t *testing.T, conn net.Conn) string {
	t.Helper()
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprint(conn, "ping\n")
	got, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(got)
}

// A socket the pod opens reaches the backend through fd 3: a TCP one as it is, another (an SSH
// channel) bridged through a socketpair.
func TestFDChannel(t *testing.T) {
	ch, theirs, err := newFDChannel()
	if err != nil {
		t.Fatal(err)
	}
	defer ch.close()
	defer theirs.Close()
	l := lineEcho(t)

	tcp, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	f, err := socketFile(tcp)
	if err != nil {
		t.Fatal(err)
	}
	id, err := ch.send(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	if got := pingThrough(t, receiveFD(t, theirs, id)); got != "echo ping" {
		t.Fatalf("tcp: %q", got)
	}

	// Not an OS socket: bridged.
	near, far := net.Pipe()
	go func() {
		defer far.Close()
		r := bufio.NewReader(far)
		l, _ := r.ReadString('\n')
		fmt.Fprint(far, "bridged "+l)
	}()
	f, err = socketFile(near)
	if err != nil {
		t.Fatal(err)
	}
	id, err = ch.send(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	if got := pingThrough(t, receiveFD(t, theirs, id)); got != "bridged ping" {
		t.Fatalf("bridge: %q", got)
	}
}

func TestPodAsk(t *testing.T) {
	s, _ := newServer(t)
	got := make(chan string, 1)
	go func() {
		got <- s.podAsks.ask(context.Background(), s, "root", plugins.Question{Kind: "permission", Name: "Greet", Text: "db:5432"}, 5*time.Second)
	}()
	var qs []plugins.Question
	for i := 0; i < 100 && len(qs) == 0; i++ {
		time.Sleep(10 * time.Millisecond)
		qs = s.podAsks.of("root")
	}
	if len(qs) != 1 || !strings.HasPrefix(qs[0].ID, "pod:") || len(s.podAsks.of("other")) != 0 {
		t.Fatalf("listed: %+v", qs)
	}
	if err := s.podAsks.answer(qs[0].ID, "other", dialAllow); err == nil {
		t.Fatal("answered from another project")
	}
	if err := s.podAsks.answer(qs[0].ID, "root", dialAllow); err != nil {
		t.Fatal(err)
	}
	if a := <-got; a != dialAllow || len(s.podAsks.of("root")) != 0 {
		t.Fatalf("answer %q", a)
	}
	// Unanswered: nothing, and gone from the list.
	if a := s.podAsks.ask(context.Background(), s, "root", plugins.Question{Kind: "permission"}, 30*time.Millisecond); a != "" || len(s.podAsks.of("root")) != 0 {
		t.Fatalf("timeout: %q", a)
	}
}

func ext(id string, grants ...string) plugins.External {
	return plugins.External{Manifest: plugins.Manifest{ID: id, Name: id}, Grants: grants}
}

func TestPluginVault(t *testing.T) {
	s, _ := newServer(t)
	call := func(e plugins.External, method, key, value string) (map[string]any, error) {
		p, _ := json.Marshal(map[string]string{"key": key, "value": value})
		r, err := s.pluginVault(e, method, p)
		m, _ := r.(map[string]any)
		return m, err
	}
	a, b := ext("alpha", "vault"), ext("beta", "vault")
	if _, err := call(a, "vault.set", "token", "s3cret"); err != nil {
		t.Fatal(err)
	}
	if r, _ := call(a, "vault.get", "token", ""); r["value"] != "s3cret" || r["found"] != true {
		t.Fatalf("its own: %v", r)
	}
	if r, _ := call(b, "vault.get", "token", ""); r["found"] != false {
		t.Fatalf("another plugin's: %v", r)
	}
	var all map[string]json.RawMessage
	if err := s.Store.ReadJSON("secrets.json", &all); err != nil || string(all["plugin:alpha/token"]) != `"s3cret"` {
		t.Fatalf("secrets.json: %v %s", err, all["plugin:alpha/token"])
	}
	if _, err := call(ext("alpha"), "vault.get", "token", ""); err == nil || !strings.Contains(err.Error(), "vault is not granted") {
		t.Fatalf("no grant: %v", err)
	}
	if _, err := call(a, "vault.get", "", ""); err == nil {
		t.Fatal("an empty key")
	}
	_, _ = call(a, "vault.delete", "token", "")
	if r, _ := call(a, "vault.get", "token", ""); r["found"] != false {
		t.Fatalf("deleted: %v", r)
	}
}

func TestPluginDialGrants(t *testing.T) {
	s, _ := newServer(t)
	ch, theirs, _ := newFDChannel()
	defer ch.close()
	defer theirs.Close()
	dial := func(e plugins.External, args string) error {
		_, err := s.pluginDial(context.Background(), nil, e, ch, json.RawMessage(args))
		return err
	}
	if err := dial(ext("db"), `{"host":"127.0.0.1","port":5432}`); err == nil || !strings.Contains(err.Error(), "dial is not granted") {
		t.Fatalf("without dial: %v", err)
	}
	if err := dial(ext("db", "dial"), `{"host":"127.0.0.1","port":5432,"ssh":{"host":"h","user":"u","auth":"agent"}}`); err == nil || !strings.Contains(err.Error(), "ssh is not granted") {
		t.Fatalf("without ssh: %v", err)
	}
	if err := dial(ext("db", "dial", "ssh"), `{"host":"127.0.0.1","port":5432,"ssh":{"host":"h","user":"u","auth":"key","keyPath":"/etc/shadow"}}`); err == nil || !strings.Contains(err.Error(), "~/.ssh") {
		t.Fatalf("a key out of ~/.ssh: %v", err)
	}
	for _, bad := range []string{`{"host":"","port":1}`, `{"host":"a b","port":1}`, `{"host":"h","port":70000}`} {
		if err := dial(ext("db", "dial"), bad); err == nil || !strings.Contains(err.Error(), "invalid destination") {
			t.Fatalf("%s: %v", bad, err)
		}
	}
}
