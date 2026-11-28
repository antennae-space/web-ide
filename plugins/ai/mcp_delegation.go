package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"
	"unicode/utf8"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/plugins/ai/llm"
	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/plugins"
)

const (
	delegationPromptBytes = 16 << 10
	delegationResultBytes = 8 << 10
	delegationDuration    = 2 * time.Minute
	delegationModelSteps  = 8
	delegationToolSteps   = 24
	delegationWaitDefault = 15_000
	delegationWaitMax     = 20_000
)

var errMCPConversation = i18n.New("conversation is unavailable to this MCP credential")

type delegationResult struct {
	Chat      string `json:"chat"`
	Turn      string `json:"turn"`
	State     string `json:"state"`
	TimedOut  bool   `json:"timed_out"`
	Answer    string `json:"answer,omitempty"`
	Error     string `json:"error,omitempty"`
	Question  string `json:"question,omitempty"`
	Server    string `json:"server,omitempty"`
	Model     string `json:"model,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

type delegationUpdate struct {
	result  delegationResult
	err     error
	changed chan struct{}
}

// Publication follows the save. Waiters never hold the run's lock while a tool
// or an IDE approval is in progress.
func (r *assistantRun) publishDelegation(err error) {
	next := &delegationUpdate{result: delegationSnapshot(r.chat), err: err, changed: make(chan struct{})}
	if previous := r.delegation.Swap(next); previous != nil {
		close(previous.changed)
	}
}

func delegationText(c *engine.Chat, state string) string {
	d := c.Delegation
	return delegationJSON(delegationResult{Chat: c.ID, Turn: d.Turn, State: state,
		Server: c.Server, Model: c.Model})
}

func delegationJSON(result delegationResult) string {
	data, _ := json.Marshal(result)
	return string(data)
}

func delegationCut(text string) string {
	if len(text) <= delegationResultBytes {
		return text
	}
	end := delegationResultBytes
	for !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end]
}

// Use the sub-agent default, or the Assistant's last selection if the user
// approved it for delegation. An explicit selection uses the same approval check.
func (s *A) delegationModel(ctx context.Context, server, model string) (string, string, error) {
	if server == "" && model == "" {
		server, model = s.LLM.ChildDefault()
		if server == "" && model == "" {
			ds, dm := s.LLM.Default()
			if s.delegationModelConfigured(ds, dm) {
				server, model = ds, dm
			}
		}
	}
	if server == "" || model == "" {
		return "", "", i18n.New("Configure a server and model for sub-agents in Assistant settings")
	}
	if !s.delegationModelConfigured(server, model) {
		return "", "", i18n.New("this model is not configured for Assistant delegation")
	}
	info := s.modelInfo(ctx, server, model)
	if !info.found || !info.caps.CanChat() {
		return "", "", i18n.Errorf("model %q is not available on server %q", model, server)
	}
	return server, model, nil
}

func (s *A) delegationModelConfigured(server, model string) bool {
	ds, dm := s.LLM.ChildDefault()
	if model != "" && server != "" && server == ds && model == dm {
		return true
	}
	for _, srv := range s.LLM.ForChildren() {
		if srv.ID == server && slices.ContainsFunc(srv.Models, func(m llm.ModelConf) bool { return m.ID == model }) {
			return true
		}
	}
	return false
}

func (s *A) startMCPDelegation(sc plugins.MCPScope, c *engine.Chat, from int) error {
	if !s.mcpChatAllowed(sc, c) {
		return errMCPConversation
	}
	if c.Delegation.Turn != "" && delegationWaiting(c.Delegation.State) {
		// Only the retained transcript can survive a pod restart.
		c.Running, c.Approval, c.Queue = nil, nil, nil
		closeToolCalls(c, "Interrupted: the pod stopped before this tool ended.")
	}
	return s.startRunGranted(chatLocOf(sc.Root), sc.Root.ID, c.MCPProject, sc.Lang, c, from, sc.RefreshDelegationGrant)
}

func (s *A) loadMCPChat(sc plugins.MCPScope, id string) (*engine.Chat, error) {
	c, err := s.loadChat(chatLocOf(sc.Root), id)
	if err != nil || !s.mcpChatAllowed(sc, c) {
		return nil, errMCPConversation
	}
	return c, nil
}

func (s *A) delegationMCPTools() []plugins.MCPTool {
	chat := plugins.Str("Conversation id returned by assistant_start or kanban_develop")
	turn := plugins.Str("Turn id returned by assistant_start, assistant_send or assistant_wait. Defaults to the current turn")
	return []plugins.MCPTool{
		{
			Name:        "assistant_wait",
			Description: "Waits for an owned Assistant turn to finish or need the user. Returns the state, result and whether the wait timed out.",
			Props: map[string]any{"chat": chat, "turn": turn, "timeout_ms": map[string]any{
				"type": "integer", "minimum": 0, "maximum": delegationWaitMax, "default": delegationWaitDefault,
				"description": "Wait time in milliseconds. Use zero for the current state."}},
			Required: []string{"chat"},
			Run: func(ctx context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
				a, err := bind[struct {
					Chat, Turn string
					Timeout    *int `json:"timeout_ms"`
				}](raw)
				if err != nil {
					return "", err
				}
				timeout := delegationWaitDefault
				if a.Timeout != nil {
					timeout = *a.Timeout
				}
				if timeout < 0 || timeout > delegationWaitMax {
					return "", i18n.New("timeout_ms must be between 0 and 20000")
				}
				res, err := s.waitDelegation(ctx, sc, a.Chat, a.Turn, time.Duration(timeout)*time.Millisecond)
				if err != nil {
					return "", err
				}
				return delegationJSON(res), nil
			},
		},
		{
			Name:        "assistant_stop",
			Description: "Cancels an owned Assistant turn, drops its queued messages and keeps its transcript.",
			Props:       map[string]any{"chat": chat, "turn": turn},
			Required:    []string{"chat"},
			Run: func(_ context.Context, sc plugins.MCPScope, raw json.RawMessage) (string, error) {
				a, err := bind[struct{ Chat, Turn string }](raw)
				if err != nil {
					return "", err
				}
				res, err := s.stopMCPDelegation(sc, a.Chat, a.Turn)
				if err != nil {
					return "", err
				}
				return delegationJSON(res), nil
			},
		},
	}
}

func delegationSnapshot(c *engine.Chat) delegationResult {
	d := c.Delegation
	res := delegationResult{Chat: c.ID, Turn: d.Turn, State: d.State}
	switch d.State {
	case "waiting_user":
		res.Question = pendingQuestions(c, "The user can answer in the Questions tool of the IDE.")
		if c.Approval != nil && res.Question == "" {
			res.Question = "Approval is pending in the IDE."
		}
	case "completed", "failed":
		for i := len(c.Messages) - 1; i >= max(0, d.From); i-- {
			m := c.Messages[i]
			if m.Role == "assistant" {
				res.Answer, res.Error = assistant.ContentText(m.Content), m.Error
				break
			}
		}
	}
	if d.Error != "" {
		res.Error = d.Error
	}
	if res.Error != "" {
		res.Answer = ""
	}
	for _, field := range []*string{&res.Question, &res.Error, &res.Answer} {
		if len(*field) > delegationResultBytes {
			*field = delegationCut(*field)
			res.Truncated = true
		}
	}
	return res
}

func delegationWaiting(state string) bool {
	return state == "running" || state == "queued" || state == "stopping" || state == "compacting"
}

func (s *A) waitDelegation(ctx context.Context, sc plugins.MCPScope, id, turn string, timeout time.Duration) (delegationResult, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	c, err := s.loadMCPChat(sc, id)
	if err != nil || c.Delegation == nil || turn != "" && c.Delegation.Turn != turn {
		return delegationResult{}, errMCPConversation
	}
	turn = c.Delegation.Turn
	r := s.run(id)
	if r == nil || r.turn != turn {
		if delegationWaiting(c.Delegation.State) {
			// The run saves its final state before it leaves the active map.
			c, err = s.loadMCPChat(sc, id)
			if err != nil || c.Delegation == nil || c.Delegation.Turn != turn {
				return delegationResult{}, errMCPConversation
			}
		}
		res := delegationSnapshot(c)
		if delegationWaiting(res.State) {
			interruptDelegation(c)
			res = delegationSnapshot(c)
		}
		if !sc.RefreshDelegationGrant() {
			return delegationResult{}, errMCPConversation
		}
		return res, nil
	}

	timedOut := false
	for {
		// The saved conversation is the first read. The update supplies the
		// second read and its signal atomically. A waiter keeps this run even
		// if a follow-up starts before the waiter wakes.
		update := r.delegation.Load()
		if !sc.RefreshDelegationGrant() {
			return delegationResult{}, errMCPConversation
		}
		res := update.result
		if update.err != nil {
			return delegationResult{}, fmt.Errorf("cannot read saved turn: %w", update.err)
		}
		if !delegationWaiting(res.State) || timeout == 0 || timedOut {
			res.TimedOut = timedOut && delegationWaiting(res.State)
			return res, nil
		}
		select {
		case <-ctx.Done():
			return delegationResult{}, ctx.Err()
		case <-deadline.C:
			timedOut = true
		case <-update.changed:
		}
	}
}

// stopRun uses the same cancellation path for MCP and the Assistant UI.
// The caller holds r.mu.
func (s *A) stopRun(r *assistantRun) {
	if r.done || r.ctx.Err() != nil {
		return
	}
	r.cancel()
	if d := r.chat.Delegation; d != nil {
		d.State = "stopping"
		r.chat.Queue = nil
		s.publish(r, -1)
	}
}

func (s *A) stopDelegation(project, parent string) {
	s.assistants.mu.Lock()
	var active *assistantRun
	for _, r := range s.assistants.runs {
		if r.project == project && r.acpParent == parent {
			active = r
			break
		}
	}
	s.assistants.mu.Unlock()
	if active != nil {
		active.mu.Lock()
		s.stopRun(active)
		active.mu.Unlock()
	}
}

func (s *A) stopMCPDelegation(sc plugins.MCPScope, id, turn string) (delegationResult, error) {
	c, err := s.loadMCPChat(sc, id)
	if err != nil || c.Delegation == nil || turn != "" && c.Delegation.Turn != turn {
		return delegationResult{}, errMCPConversation
	}
	turn = c.Delegation.Turn
	if r := s.run(id); r != nil {
		r.mu.Lock()
		if !s.mcpChatAllowed(sc, r.chat) || r.turn != turn {
			r.mu.Unlock()
			return delegationResult{}, errMCPConversation
		}
		if !r.done {
			s.stopRun(r)
			res, err := delegationSnapshot(r.chat), r.delegation.Load().err
			r.mu.Unlock()
			return res, err
		}
		r.mu.Unlock()
	}
	// A turn waiting for answers may have already released its run.
	s.assistants.mu.Lock()
	defer s.assistants.mu.Unlock()
	c, err = s.loadMCPChat(sc, id)
	if err != nil || c.Delegation == nil || turn != "" && c.Delegation.Turn != turn || s.assistants.runs[id] != nil {
		return delegationResult{}, errMCPConversation
	}
	if c.Delegation.State == "waiting_user" {
		from := stopDelegatedChat(c)
		return delegationSnapshot(c), s.publishIdle(chatLocOf(sc.Root), sc.Root.ID, c, from)
	}
	res := delegationSnapshot(c)
	if delegationWaiting(res.State) {
		res.State, res.Error = "failed", "Interrupted: the pod stopped."
	}
	return res, nil
}

func stopDelegatedChat(c *engine.Chat) int {
	c.Queue = nil
	from := skipQuestions(c)
	if n := len(c.Messages); n == 0 || c.Messages[n-1].Error != "Stopped." {
		from = minFrom(from, len(c.Messages))
		c.Messages = append(c.Messages, &engine.Message{Role: "assistant", Error: "Stopped."})
	}
	c.Delegation.State = "cancelled"
	return from
}

// limitDelegation cancels pending work and records why the turn failed.
// The caller holds r.mu.
func (r *assistantRun) limitDelegation() {
	r.chat.Delegation.Error = i18n.T(r.lang, "Assistant delegation reached its execution limit")
	r.cancel()
}

func (r *assistantRun) failDelegation() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.limitDelegation()
}

func finishDelegation(r *assistantRun) int {
	c, d := r.chat, r.chat.Delegation
	if errors.Is(r.ctx.Err(), context.DeadlineExceeded) {
		d.Error = i18n.T(r.lang, "Assistant delegation reached its execution limit")
	}
	if d.Error != "" {
		d.State = "failed"
		c.Queue = nil
		from := minFrom(len(c.Messages), skipQuestions(c))
		c.Messages = append(c.Messages, &engine.Message{Role: "assistant", Error: d.Error})
		return from
	}
	if r.ctx.Err() != nil {
		return stopDelegatedChat(c)
	}
	if waitsForUser(c) {
		d.State = "waiting_user"
		return -1
	}
	d.State = "failed"
	for i := len(c.Messages) - 1; i >= d.From; i-- {
		if m := c.Messages[i]; m.Role == "assistant" {
			if m.Error == "" && len(m.ToolCalls) == 0 {
				d.State = "completed"
			} else if m.Error == "" {
				d.Error = i18n.T(r.lang, "Assistant delegation ended without a final answer")
			}
			return -1
		}
	}
	d.Error = i18n.T(r.lang, "Assistant delegation ended without a final answer")
	c.Messages = append(c.Messages, &engine.Message{Role: "assistant", Error: d.Error})
	return len(c.Messages) - 1
}

func interruptDelegation(c *engine.Chat) {
	c.Running, c.Approval, c.Queue = nil, nil, nil
	closeToolCalls(c, "Interrupted: the pod stopped before this tool ended.")
	if c.Delegation.State == "stopping" {
		stopDelegatedChat(c)
		return
	}
	err := "Interrupted: the pod stopped."
	c.Delegation.State, c.Delegation.Error = "failed", err
	c.Messages = append(c.Messages, &engine.Message{Role: "assistant", Error: err})
}
