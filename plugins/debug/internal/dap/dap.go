// Package dap is the client of the Debug Adapter Protocol (https://microsoft.github.io/debug-adapter-protocol)
// the debug host speaks to an adapter (#188, docs/design/debug.md). One client per session, over
// the adapter's pipes (stdio) or a socket (tcp): requests matched by their sequence number,
// events handed to the host, and the requests the adapter sends back (runInTerminal) answered by
// it.
package dap

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
)

// MaxBody caps one message (a huge variable list should not eat the pod's memory).
const MaxBody = 32 << 20

// Event is an event of the adapter (initialized, stopped, output, breakpoint…).
type Event struct {
	Event string          `json:"event"`
	Body  json.RawMessage `json:"body"`
}

// Request is a request the adapter sends to the host (runInTerminal, startDebugging…).
type Request struct {
	Command string          `json:"command"`
	Args    json.RawMessage `json:"arguments"`
}

// Options are what the host gives the client: the events, and the way it answers the adapter's
// own requests (nil refuses them).
type Options struct {
	Event   func(Event)
	Reverse func(ctx context.Context, req Request) (any, error)
}

// Client speaks DAP on one connection.
type Client struct {
	w    io.Writer
	opts Options
	// closer ends the connection (the adapter's process, the socket).
	closer func()

	mu      sync.Mutex
	seq     int
	pending map[int]chan Result
	err     error
	closed  chan struct{}
	once    sync.Once
}

// Result is the answer to a request: the body of the response, or the error the adapter gave.
type Result struct {
	Body json.RawMessage
	Err  error
}

// New starts reading messages on r, writing to w. The host closes the client with Close.
func New(r io.Reader, w io.Writer, opts Options, closer func()) *Client {
	c := &Client{w: w, opts: opts, closer: closer, pending: map[int]chan Result{}, closed: make(chan struct{})}
	go c.readLoop(bufio.NewReader(r))
	return c
}

// Err is why the connection ended (nil while it is open).
func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Closed tells that the connection is over.
func (c *Client) Closed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

// Close ends the connection and what the adapter runs.
func (c *Client) Close() {
	c.close(errors.New("the debug session ended"))
}

func (c *Client) close(err error) {
	c.once.Do(func() {
		c.mu.Lock()
		if c.err == nil {
			c.err = err
		}
		pending := c.pending
		c.pending = map[int]chan Result{}
		c.mu.Unlock()
		for _, ch := range pending {
			ch <- Result{Err: err}
		}
		close(c.closed)
		if c.closer != nil {
			c.closer()
		}
	})
}

// Request sends a request and waits for its answer.
func (c *Client) Request(ctx context.Context, command string, args any) (json.RawMessage, error) {
	ch, err := c.Send(command, args)
	if err != nil {
		return nil, err
	}
	select {
	case res := <-ch:
		return res.Body, res.Err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.closed:
		return nil, c.Err()
	}
}

// Send sends a request and answers at once with the channel of its response: an adapter may
// answer `launch` only after `configurationDone`, so the host waits for the `initialized` event
// instead of blocking on it.
func (c *Client) Send(command string, args any) (<-chan Result, error) {
	msg := map[string]any{"seq": 0, "type": "request", "command": command}
	if args != nil {
		msg["arguments"] = args
	}
	c.mu.Lock()
	if c.err != nil {
		defer c.mu.Unlock()
		return nil, c.err
	}
	c.seq++
	seq := c.seq
	msg["seq"] = seq
	ch := make(chan Result, 1)
	c.pending[seq] = ch
	c.mu.Unlock()
	if err := write(c.w, msg); err != nil {
		c.mu.Lock()
		delete(c.pending, seq)
		c.mu.Unlock()
		return nil, err
	}
	return ch, nil
}

// readLoop reads the messages until the connection ends.
func (c *Client) readLoop(r *bufio.Reader) {
	for {
		body, err := read(r)
		if err != nil {
			c.close(err)
			return
		}
		var m struct {
			Seq        int             `json:"seq"`
			Type       string          `json:"type"`
			Command    string          `json:"command"`
			Event      string          `json:"event"`
			RequestSeq int             `json:"request_seq"`
			Success    *bool           `json:"success"`
			Message    string          `json:"message"`
			Body       json.RawMessage `json:"body"`
			Arguments  json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(body, &m); err != nil {
			continue
		}
		switch m.Type {
		case "response":
			c.mu.Lock()
			ch := c.pending[m.RequestSeq]
			delete(c.pending, m.RequestSeq)
			c.mu.Unlock()
			if ch == nil {
				continue
			}
			if m.Success != nil && !*m.Success {
				text := m.Message
				if text == "" {
					text = "the adapter refused the request"
				}
				ch <- Result{Err: errors.New(text)}
			} else {
				ch <- Result{Body: m.Body}
			}
		case "event":
			if c.opts.Event != nil {
				c.opts.Event(Event{Event: m.Event, Body: m.Body})
			}
		case "request":
			c.answer(Request{Command: m.Command, Args: m.Arguments}, m.Seq)
		}
	}
}

// answer replies to a request the adapter sent.
func (c *Client) answer(req Request, seq int) {
	var (
		res any
		err error
	)
	if c.opts.Reverse == nil {
		err = fmt.Errorf("the host does not answer %s", req.Command)
	} else {
		res, err = c.opts.Reverse(context.Background(), req)
	}
	msg := map[string]any{"seq": 0, "type": "response", "command": req.Command, "request_seq": seq, "success": err == nil}
	if err != nil {
		msg["message"] = err.Error()
	} else {
		msg["body"] = res
	}
	c.mu.Lock()
	c.seq++
	msg["seq"] = c.seq
	c.mu.Unlock()
	_ = write(c.w, msg)
}

// write sends one message: JSON framed by its Content-Length.
func write(w io.Writer, msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, "Content-Length: "+strconv.Itoa(len(data))+"\r\n\r\n")
	if err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

// read reads one framed message.
func read(r *bufio.Reader) ([]byte, error) {
	length := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil || n < 0 || n > MaxBody {
				return nil, fmt.Errorf("bad Content-Length %q", value)
			}
			length = n
		}
	}
	if length < 0 {
		return nil, errors.New("a DAP message has no Content-Length")
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return body, nil
}
