// The backend of the two fixture plugins of the capabilities suite (#155), by the id it is
// started for. alpha provides greeting: alpha.greet answers who asked it, and emits
// alpha.greeted. beta requires greeting: beta.ask calls alpha.greet through the core
// (service.call), beta.listen hears alpha's events (service.on), beta.heard tells the last one,
// beta.foreign asks a method out of alpha's namespace.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"strconv"
	"sync"
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
	next    int
	plugin  string
	heard   string
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

// core asks the pod a method of the core; the text of its error, if any.
func core(method string, params any) (json.RawMessage, string) {
	ch := make(chan msg, 1)
	mu.Lock()
	next++
	id := "c" + strconv.Itoa(next)
	waiting[`"`+id+`"`] = ch
	mu.Unlock()
	write(map[string]any{"jsonrpc": "2.0", "id": id, "method": "core", "params": map[string]any{"method": method, "params": params}})
	m := <-ch
	if m.Error != nil {
		return nil, m.Error.Message
	}
	return m.Result, ""
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
		var p struct{ Plugin string }
		json.Unmarshal(m.Params, &p)
		plugin = p.Plugin
		reply(m.ID, map[string]any{})
	case "shutdown":
		reply(m.ID, map[string]any{})
		os.Exit(0)
	case "event":
		// An event of a plugin this one listens to (service.on).
		var e struct {
			Event string
			Data  json.RawMessage
		}
		json.Unmarshal(m.Params, &e)
		mu.Lock()
		heard = e.Event + " " + string(e.Data)
		mu.Unlock()
	case "call":
		var c struct {
			Method string
			From   string
			Params struct{ Name string }
		}
		json.Unmarshal(m.Params, &c)
		switch c.Method {
		case "alpha.greet":
			who := c.From
			if who == "" {
				who = "a window"
			}
			write(map[string]any{"jsonrpc": "2.0", "method": "emit", "params": map[string]any{"event": "alpha.greeted", "data": c.Params.Name}})
			reply(m.ID, "Hello "+c.Params.Name+" from the backend of alpha, asked by "+who)
		case "beta.ask":
			res, e := core("service.call", map[string]any{"capability": "greeting", "method": "alpha.greet", "params": map[string]any{"name": "beta"}})
			if e != "" {
				reply(m.ID, "refused: "+e)
				return
			}
			var s string
			json.Unmarshal(res, &s)
			reply(m.ID, s)
		case "beta.listen":
			res, e := core("service.on", map[string]any{"capability": "greeting"})
			if e != "" {
				reply(m.ID, "refused: "+e)
				return
			}
			reply(m.ID, string(res))
		case "beta.heard":
			mu.Lock()
			h := heard
			mu.Unlock()
			reply(m.ID, h)
		case "beta.foreign":
			_, e := core("service.call", map[string]any{"capability": "greeting", "method": "beta.ask"})
			reply(m.ID, "refused: "+e)
		default:
			fail(m.ID, "unknown method "+c.Method+" of "+plugin)
		}
	default:
		if len(m.ID) > 0 {
			fail(m.ID, "unknown "+m.Method)
		}
	}
}
