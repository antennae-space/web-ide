package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"path/filepath"
	"strings"
	"testing"

	"antennae.space/ide/pod/runtime"
)

func TestDockerSocket(t *testing.T) {
	env := map[string]string{}
	get := func(k string) string { return env[k] }
	if p, _ := dockerSocket(get); p != "/var/run/docker.sock" {
		t.Fatalf("default: %s", p)
	}
	dir := t.TempDir()
	l, err := net.Listen("unix", filepath.Join(dir, "docker.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	env["XDG_RUNTIME_DIR"] = dir
	if p, _ := dockerSocket(get); p != filepath.Join(dir, "docker.sock") {
		t.Fatalf("rootless: %s", p)
	}
	env["DOCKER_HOST"] = "unix:///x/d.sock"
	if p, _ := dockerSocket(get); p != "/x/d.sock" {
		t.Fatalf("DOCKER_HOST: %s", p)
	}
	env["DOCKER_HOST"] = "tcp://h:2375"
	if _, err := dockerSocket(get); err == nil {
		t.Fatal("a TCP DOCKER_HOST")
	}
}

// The Docker socket is opened by the pod and handed to a backend granted socket:docker.
func TestPluginSocket(t *testing.T) {
	s, _ := newServer(t)
	dir := t.TempDir()
	sock := filepath.Join(dir, "docker.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		line, _ := bufio.NewReader(c).ReadString('\n')
		fmt.Fprint(c, "engine "+line)
	}()
	t.Setenv("DOCKER_HOST", "unix://"+sock)
	ch, theirs, _ := newFDChannel()
	defer ch.close()
	defer theirs.Close()
	rt := &runtime.Runtime{Local: true}
	call := func(grants ...string) (any, error) {
		return s.pluginSocket(context.Background(), rt, ext("docker", grants...), ch, json.RawMessage(`{"name":"docker"}`))
	}
	if _, err := call(); err == nil || !strings.Contains(err.Error(), "socket:docker is not granted") {
		t.Fatalf("without its grant: %v", err)
	}
	if _, err := s.pluginSocket(context.Background(), rt, ext("docker", "socket:docker"), ch, json.RawMessage(`{"name":"ssh-agent"}`)); err == nil {
		t.Fatal("an unknown socket")
	}
	r, err := call("socket:docker")
	if err != nil {
		t.Fatal(err)
	}
	conn := receiveFD(t, theirs, r.(map[string]any)["fd"].(int))
	if got := pingThrough(t, conn); got != "engine ping" {
		t.Fatalf("through the socket: %q", got)
	}
}
