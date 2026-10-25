// The backend of the fixture plugin greet of the externals suite (#130): JSON-RPC over stdio.
// It answers greet.hello (and emits greet.said), tries what it must not reach (greet.probe),
// asks the core for fs.list (greet.core), for a connection the pod opens (greet.dial: an echo
// through the socket it receives on fd 3), for its vault entry (greet.secret), and runs its
// assistant tool greet_hello; its actions greet.count and greet.write (#151), its targets
// (greet.targets) and its settings (greet.settings).
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type msg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

var (
	mu      sync.Mutex
	out     = json.NewEncoder(os.Stdout)
	waiting = map[string]chan msg{}
	root    string
	size    string // the last size of its console
)

func write(v any) {
	mu.Lock()
	defer mu.Unlock()
	out.Encode(v)
}

func reply(id json.RawMessage, result any) {
	write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func fail(id json.RawMessage, text string) {
	write(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32000, "message": text}})
}

// core asks the pod a method of the core.
func core(method string, params any) (json.RawMessage, string) {
	ch := make(chan msg, 1)
	mu.Lock()
	id := "c" + time.Now().Format("150405.000000000")
	waiting[`"`+id+`"`] = ch
	mu.Unlock()
	write(map[string]any{"jsonrpc": "2.0", "id": id, "method": "core", "params": map[string]any{"method": method, "params": params}})
	m := <-ch
	if m.Error != nil {
		return nil, m.Error.Message
	}
	return m.Result, ""
}

func try(err error) string {
	if err == nil {
		return "ok"
	}
	return "blocked"
}

func main() {
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 8<<20)
	for in.Scan() {
		var m msg
		if json.Unmarshal(in.Bytes(), &m) != nil {
			continue
		}
		if m.Method == "" {
			mu.Lock()
			ch := waiting[string(m.ID)]
			delete(waiting, string(m.ID))
			mu.Unlock()
			if ch != nil {
				ch <- m
			}
			continue
		}
		go handle(m)
	}
}

func handle(m msg) {
	switch m.Method {
	case "initialize":
		var p struct {
			Project struct{ Root string }
		}
		json.Unmarshal(m.Params, &p)
		root = p.Project.Root
		reply(m.ID, map[string]any{})
	case "shutdown":
		reply(m.ID, map[string]any{})
		os.Exit(0)
	case "call":
		var c struct {
			Method string
			Params struct {
				Key   string `json:"key"`
				Port  int    `json:"port"`
				Value string `json:"value"`
				Conn  string `json:"conn"`
			}
		}
		json.Unmarshal(m.Params, &c)
		switch c.Method {
		case "greet.hello":
			write(map[string]any{"jsonrpc": "2.0", "method": "emit", "params": map[string]any{"event": "greet.said", "data": "said by the backend"}})
			reply(m.ID, "Hello from the backend")
		case "greet.probe":
			// What a confined backend must not reach: the pod's key, the network; what it may:
			// the project (files:read).
			_, keyErr := os.ReadFile(c.Params.Key)
			_, projErr := os.ReadFile(filepath.Join(root, "notes.txt"))
			conn, netErr := net.DialTimeout("tcp", "1.1.1.1:443", 2*time.Second)
			if conn != nil {
				conn.Close()
			}
			reply(m.ID, map[string]string{"key": try(keyErr), "project": try(projErr), "net": try(netErr)})
		case "greet.core":
			if _, e := core("fs.list", map[string]any{"path": ""}); e != "" {
				reply(m.ID, "refused: "+e)
			} else {
				reply(m.ID, "answered")
			}
		case "greet.dial":
			reply(m.ID, echo(c.Params.Port))
		case "greet.secret":
			if _, e := core("vault.set", map[string]any{"key": "token", "value": c.Params.Value}); e != "" {
				reply(m.ID, "refused: "+e)
				return
			}
			got, e := core("vault.get", map[string]any{"key": "token"})
			if e != "" {
				reply(m.ID, "refused: "+e)
				return
			}
			var v struct{ Value string }
			json.Unmarshal(got, &v)
			reply(m.ID, v.Value)
		case "greet.docker": // the Docker socket the pod opens (#147): the version of the engine
			reply(m.ID, dockerVersion())
		case "greet.terminal": // a console of the core it feeds (#147): an echo in upper case
			reply(m.ID, terminal())
		case "greet.size":
			mu.Lock()
			last := size
			mu.Unlock()
			reply(m.ID, last)
		case "greet.count": // an action that reads (#151)
			reply(m.ID, 3)
		case "greet.write": // an action that writes, on the target conn
			reply(m.ID, "written "+c.Params.Conn)
		case "greet.targets":
			if _, e := core("ai.targets", map[string]any{"targets": []map[string]string{{"id": "main", "label": "Main DB"}}}); e != "" {
				reply(m.ID, "refused: "+e)
				return
			}
			reply(m.ID, "declared")
		case "greet.settings":
			got, e := core("settings.get", map[string]any{})
			if e != "" {
				reply(m.ID, "refused: "+e)
				return
			}
			reply(m.ID, string(got))
		default:
			fail(m.ID, "no "+c.Method)
		}
	case "terminal.resize": // a notification of the pod: no answer
		var r struct{ Cols, Rows int }
		json.Unmarshal(m.Params, &r)
		mu.Lock()
		size = fmt.Sprintf("%dx%d", r.Cols, r.Rows)
		mu.Unlock()
	case "tool":
		reply(m.ID, map[string]any{"content": "Hello from the tool of the backend", "summary": "greeted"})
	default:
		fail(m.ID, "unknown method: "+m.Method)
	}
}

// echo asks the pod for a connection to 127.0.0.1:port, takes its socket from fd 3, sends
// "ping" and answers what comes back.
func echo(port int) string {
	res, e := core("dial", map[string]any{"host": "127.0.0.1", "port": port})
	if e != "" {
		return "refused: " + e
	}
	var r struct{ Fd int }
	json.Unmarshal(res, &r)
	conn, err := receive(r.Fd)
	if err != nil {
		return "no socket: " + err.Error()
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprint(conn, "ping\n")
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return "read: " + err.Error()
	}
	return "echo: " + line[:len(line)-1]
}

// fd3 is kept for the life of the process: an *os.File closes its fd when collected.
var fd3 = os.NewFile(3, "fds")

// receive takes the socket the pod sent on fd 3 with the id id.
func receive(id int) (net.Conn, error) {
	ch, err := net.FileConn(fd3) // a dup: fd 3 stays open
	if err != nil {
		return nil, err
	}
	defer ch.Close()
	buf, oob := make([]byte, 32), make([]byte, syscall.CmsgSpace(4))
	n, oobn, _, _, err := ch.(*net.UnixConn).ReadMsgUnix(buf, oob)
	if err != nil {
		return nil, err
	}
	if got, _ := strconv.Atoi(string(buf[:n])); got != id {
		return nil, fmt.Errorf("socket %d, expected %d", got, id)
	}
	msgs, err := syscall.ParseSocketControlMessage(oob[:oobn])
	if err != nil || len(msgs) != 1 {
		return nil, fmt.Errorf("no socket in the message")
	}
	fds, err := syscall.ParseUnixRights(&msgs[0])
	if err != nil || len(fds) != 1 {
		return nil, fmt.Errorf("no socket in the message")
	}
	f := os.NewFile(uintptr(fds[0]), "conn")
	defer f.Close()
	return net.FileConn(f)
}

// dockerVersion asks the pod for the Docker socket and the engine's version over it.
func dockerVersion() string {
	res, e := core("socket", map[string]any{"name": "docker"})
	if e != "" {
		return "refused: " + e
	}
	var r struct{ Fd int }
	json.Unmarshal(res, &r)
	conn, err := receive(r.Fd)
	if err != nil {
		return "no socket: " + err.Error()
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprint(conn, "GET /version HTTP/1.0\r\nHost: docker\r\n\r\n")
	body, _ := io.ReadAll(conn)
	if i := strings.Index(string(body), `"ApiVersion":"`); i >= 0 {
		return "docker api " + strings.SplitN(string(body)[i+14:], `"`, 2)[0]
	}
	return "no version: " + string(body)
}

// terminal opens a console of the core and echoes what is typed there in upper case.
func terminal() string {
	res, e := core("terminal.open", map[string]any{"title": "Greet shell"})
	if e != "" {
		return "refused: " + e
	}
	var r struct {
		Console string
		Fd      int
	}
	json.Unmarshal(res, &r)
	conn, err := receive(r.Fd)
	if err != nil {
		return "no socket: " + err.Error()
	}
	fmt.Fprint(conn, "greet> ")
	go func() {
		defer conn.Close()
		b := make([]byte, 1024)
		for {
			n, err := conn.Read(b)
			if err != nil {
				return
			}
			conn.Write([]byte(strings.ToUpper(strings.ReplaceAll(string(b[:n]), "\r", "\r\n"))))
		}
	}()
	return r.Console
}
