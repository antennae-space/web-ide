package server

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"golang.org/x/sys/unix"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/plugins/backend"
	"antennae.space/ide/pod/runtime"
)

// The sockets the pod opens for an external plugin by name (#147, docs/design/plugins.md, *API
// bricks*): its backend cannot open a unix socket (seccomp), so it asks the core `socket`; the
// pod checks the grant socket:<name>, connects to where that socket is, and hands the
// connection over on fd 3 as `dial` does. Only docker for now: who holds it is root on the host.

// dockerSocket is where the Docker socket of this machine is: $DOCKER_HOST (unix://), the
// rootless one ($XDG_RUNTIME_DIR/docker.sock), else /var/run/docker.sock.
func dockerSocket(env func(string) string) (string, error) {
	if h := env("DOCKER_HOST"); h != "" {
		p, ok := strings.CutPrefix(h, "unix://")
		if !ok {
			return "", i18n.Errorf("DOCKER_HOST %s is not a unix socket", h)
		}
		return p, nil
	}
	if d := env("XDG_RUNTIME_DIR"); d != "" {
		if st, err := os.Stat(filepath.Join(d, "docker.sock")); err == nil && st.Mode()&os.ModeSocket != 0 {
			return filepath.Join(d, "docker.sock"), nil
		}
	}
	return "/var/run/docker.sock", nil
}

// pluginSocket opens a named socket for a backend and hands it over: {fd: id}.
func (s *Server) pluginSocket(ctx context.Context, rt *runtime.Runtime, e plugins.External, ch *fdChannel, params json.RawMessage) (any, error) {
	a, err := bind[struct {
		Name string `json:"name"`
	}](params)
	if err != nil {
		return nil, err
	}
	if a.Name != "docker" {
		return nil, i18n.Errorf("unknown socket: %s", a.Name)
	}
	if !slices.Contains(e.Grants, "socket:"+a.Name) {
		return nil, i18n.Errorf("%s is not granted to %s", "socket:"+a.Name, e.Manifest.Name)
	}
	var conn net.Conn
	if rt.Local {
		p, err := dockerSocket(os.Getenv)
		if err != nil {
			return nil, err
		}
		var d net.Dialer
		if conn, err = d.DialContext(ctx, "unix", p); err != nil {
			return nil, i18n.Errorf("Docker does not answer on %s: %v", p, err)
		}
	} else {
		// The host's, through the SSH connection of the project.
		client, err := rt.SSHClient()
		if err != nil {
			return nil, err
		}
		if conn, err = client.Dial("unix", "/var/run/docker.sock"); err != nil {
			return nil, i18n.Errorf("Docker does not answer on %s: %v", "/var/run/docker.sock", err)
		}
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

// pluginTerminal opens a console of the core fed by a backend (the grant terminal): a
// socketpair, one end the console's, the other handed to the backend; a resize of the console
// reaches it as terminal.resize, and the console closed closes its end. {console, fd}.
func (s *Server) pluginTerminal(rt *runtime.Runtime, e plugins.External, ch *fdChannel, proc func() *backend.Process, params json.RawMessage) (any, error) {
	if !slices.Contains(e.Grants, "terminal") {
		return nil, i18n.Errorf("%s is not granted to %s", "terminal", e.Manifest.Name)
	}
	a, err := bind[struct {
		Title string `json:"title"`
	}](params)
	if err != nil {
		return nil, err
	}
	fds, err := socketpair(unix.SOCK_STREAM)
	if err != nil {
		return nil, err
	}
	near := os.NewFile(uintptr(fds[0]), "console")
	conn, err := net.FileConn(near)
	near.Close()
	theirs := os.NewFile(uintptr(fds[1]), "console")
	defer theirs.Close()
	if err != nil {
		return nil, err
	}
	title := a.Title
	if len(title) > 120 {
		title = title[:120]
	}
	var id string
	info := rt.Consoles.AttachStream(title, conn, func(cols, rows int) {
		if p := proc(); p != nil {
			_ = p.Notify("terminal.resize", map[string]any{"console": id, "cols": cols, "rows": rows})
		}
	})
	id = info.ID
	n, err := ch.send(theirs)
	if err != nil {
		_ = rt.Consoles.Close(id)
		return nil, err
	}
	s.emitter(rt.P.ID)("console.created", info, "")
	return map[string]any{"console": id, "fd": n}, nil
}
