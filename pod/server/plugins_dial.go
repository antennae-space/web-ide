package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/plugins/install"
	"antennae.space/ide/pod/runtime"
	"antennae.space/ide/pod/sshx"
)

// The connections the pod opens for an external plugin (docs/design/plugins.md, *API bricks*):
// its backend cannot (seccomp refuses its sockets without the grant net, and Landlock would
// filter ports only), so it asks the core `dial`; the pod checks the grant dial (ssh for a
// tunnel), asks the user once per new destination, connects, and hands the socket to the
// backend through fd 3, a socketpair it inherited (SCM_RIGHTS, the message carrying an id).

// fdChannel is the pod's end of the socketpair of a backend.
type fdChannel struct {
	mu   sync.Mutex
	c    *net.UnixConn
	next int
}

// newFDChannel makes the socketpair: the pod's end, and the backend's (inherited as fd 3).
func newFDChannel() (*fdChannel, *os.File, error) {
	fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	pod := os.NewFile(uintptr(fds[0]), "plugin-fds")
	c, err := net.FileConn(pod)
	pod.Close()
	if err != nil {
		unix.Close(fds[1])
		return nil, nil, err
	}
	return &fdChannel{c: c.(*net.UnixConn)}, os.NewFile(uintptr(fds[1]), "plugin-fds"), nil
}

// send hands f to the backend; the id answers the core call, the backend takes the file
// that carries it.
func (ch *fdChannel) send(f *os.File) (int, error) {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	ch.next++
	_, _, err := ch.c.WriteMsgUnix([]byte(strconv.Itoa(ch.next)), unix.UnixRights(int(f.Fd())), nil)
	return ch.next, err
}

func (ch *fdChannel) close() { ch.c.Close() }

// dialArgs are the params of the core call dial.
type dialArgs struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	// SSH: through a tunnel of the pod's SSH pool (its agent and keys), with the grant ssh.
	SSH *struct {
		Host       string `json:"host"`
		Port       int    `json:"port"`
		User       string `json:"user"`
		Auth       string `json:"auth"` // agent | key | password
		KeyPath    string `json:"keyPath"`
		Password   string `json:"password"`
		Passphrase string `json:"passphrase"`
	} `json:"ssh"`
}

// destination names what the user allows: host:port, and the tunnel it goes through.
func (a dialArgs) destination() string {
	d := net.JoinHostPort(a.Host, strconv.Itoa(a.Port))
	if a.SSH != nil {
		d += " via " + a.SSH.User + "@" + net.JoinHostPort(a.SSH.Host, strconv.Itoa(a.SSH.Port))
	}
	return d
}

// pluginDial opens a connection for a backend and hands it over: {fd: id}.
func (s *Server) pluginDial(ctx context.Context, rt *runtime.Runtime, e plugins.External, ch *fdChannel, params json.RawMessage) (any, error) {
	if !slices.Contains(e.Grants, "dial") {
		return nil, i18n.Errorf("%s is not granted to %s", "dial", e.Manifest.Name)
	}
	a, err := bind[dialArgs](params)
	if err != nil {
		return nil, err
	}
	if a.Host == "" || a.Port <= 0 || a.Port > 65535 || strings.ContainsAny(a.Host, " /@") {
		return nil, i18n.Errorf("invalid destination %s:%d", a.Host, a.Port)
	}
	if a.SSH != nil {
		if !slices.Contains(e.Grants, "ssh") {
			return nil, i18n.Errorf("%s is not granted to %s", "ssh", e.Manifest.Name)
		}
		if a.SSH.Port == 0 {
			a.SSH.Port = 22
		}
		// A key of the user's SSH folder only: the pod reads it, not the plugin.
		if a.SSH.KeyPath != "" {
			home, _ := os.UserHomeDir()
			if rel, err := filepath.Rel(filepath.Join(home, ".ssh"), a.SSH.KeyPath); err != nil || strings.HasPrefix(rel, "..") || !filepath.IsAbs(a.SSH.KeyPath) {
				return nil, i18n.Errorf("an SSH key must be in %s", "~/.ssh")
			}
		}
	}
	if err := s.allowDestination(ctx, rt, e, a.destination()); err != nil {
		return nil, err
	}
	conn, err := s.dialFor(ctx, a)
	if err != nil {
		return nil, err
	}
	f, err := socketFile(conn)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	id, err := ch.send(f)
	if err != nil {
		return nil, err
	}
	return map[string]any{"fd": id}, nil
}

func (s *Server) dialFor(ctx context.Context, a dialArgs) (net.Conn, error) {
	addr := net.JoinHostPort(a.Host, strconv.Itoa(a.Port))
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if a.SSH == nil {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", addr)
	}
	client, err := s.Pool.Get(sshx.Target{Host: a.SSH.Host, Port: a.SSH.Port, User: a.SSH.User, Auth: a.SSH.Auth, KeyPath: a.SSH.KeyPath},
		sshx.Creds{Password: a.SSH.Password, Passphrase: a.SSH.Passphrase})
	if err != nil {
		return nil, err
	}
	return client.DialContext(ctx, "tcp", addr)
}

// socketFile is a socket the backend can use: a TCP connection's own, else (an SSH channel)
// one end of a socketpair bridged to it.
func socketFile(conn net.Conn) (*os.File, error) {
	if tc, ok := conn.(*net.TCPConn); ok {
		f, err := tc.File() // a dup: the connection itself closes
		tc.Close()
		return f, err
	}
	fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		conn.Close()
		return nil, err
	}
	near := os.NewFile(uintptr(fds[0]), "bridge")
	nc, err := net.FileConn(near)
	near.Close()
	if err != nil {
		conn.Close()
		unix.Close(fds[1])
		return nil, err
	}
	go func() {
		done := make(chan struct{}, 2)
		cp := func(dst, src net.Conn) { _, _ = io.Copy(dst, src); done <- struct{}{} }
		go cp(conn, nc)
		go cp(nc, conn)
		<-done
		conn.Close()
		nc.Close()
	}()
	return os.NewFile(uintptr(fds[1]), "bridge"), nil
}

// The options of the question of a new destination.
const (
	dialAllow     = "allow_always"
	dialAllowOnce = "allow_once"
	dialDeny      = "reject_once"
)

// dialAskWait is how long a connection waits for the user's answer before it is refused.
var dialAskWait = 2 * time.Minute

// allowDestination asks the user, the first time, whether the plugin may reach dest.
func (s *Server) allowDestination(ctx context.Context, rt *runtime.Runtime, e plugins.External, dest string) error {
	lock, err := install.ReadLock(s.Store)
	if err != nil {
		return err
	}
	if slices.Contains(lock.Plugins[e.Manifest.ID].Destinations, dest) {
		return nil
	}
	root := s.questionRoot(rt.P.ID)
	// The page words it in the user's language: Text is the destination, Name the plugin.
	q := plugins.Question{Source: "plugin", Project: rt.P.ID, Name: e.Manifest.Name, Title: e.Manifest.Name, Kind: "permission", Text: dest,
		Options: []plugins.Option{
			{ID: dialAllow, Name: "Allow", Kind: "allow_always"},
			{ID: dialAllowOnce, Name: "Allow once", Kind: "allow_once"},
			{ID: dialDeny, Name: "Deny", Kind: "reject_once"},
		}}
	ans := s.podAsks.ask(ctx, s, root, q, dialAskWait)
	switch ans {
	case dialAllow:
		s.plugins.installMu.Lock()
		defer s.plugins.installMu.Unlock()
		lock, err := install.ReadLock(s.Store)
		if err != nil {
			return err
		}
		dests := lock.Plugins[e.Manifest.ID].Destinations
		if slices.Contains(dests, dest) {
			return nil
		}
		return s.setDestinations(e.Manifest.ID, append(slices.Clone(dests), dest))
	case dialAllowOnce:
		return nil
	}
	return i18n.Errorf("the connection of %s to %s was not allowed", e.Manifest.Name, dest)
}

// podAskRegistry holds the questions the pod itself asks (a plugin's new destination), in the
// Questions tool of the project, as ask_user's.
type podAskRegistry struct {
	mu    sync.Mutex
	next  int
	items map[string]*podAsk
}

type podAsk struct {
	root string
	q    plugins.Question
	done chan string
}

// ask puts q in the Questions tool of root and waits for the option chosen ("" when the
// wait ends first).
func (r *podAskRegistry) ask(ctx context.Context, s *Server, root string, q plugins.Question, wait time.Duration) string {
	r.mu.Lock()
	if r.items == nil {
		r.items = map[string]*podAsk{}
	}
	r.next++
	q.ID = "pod:" + strconv.Itoa(r.next)
	q.Time = time.Now().UnixMilli()
	a := &podAsk{root: root, q: q, done: make(chan string, 1)}
	r.items[q.ID] = a
	r.mu.Unlock()
	s.questionsChanged(root, q.Name)
	defer func() {
		r.mu.Lock()
		delete(r.items, q.ID)
		r.mu.Unlock()
		s.questionsChanged(root, "")
	}()
	select {
	case ans := <-a.done:
		return ans
	case <-time.After(wait):
	case <-ctx.Done():
	}
	return ""
}

func (r *podAskRegistry) of(root string) []plugins.Question {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []plugins.Question
	for _, a := range r.items {
		if a.root == root {
			out = append(out, a.q)
		}
	}
	return out
}

func (r *podAskRegistry) answer(id, root, option string) error {
	r.mu.Lock()
	a := r.items[id]
	if a == nil || a.root != root {
		r.mu.Unlock()
		return i18n.New("this question is no longer open")
	}
	delete(r.items, id)
	r.mu.Unlock()
	a.done <- option
	return nil
}
