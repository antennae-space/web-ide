package llm

import (
	"context"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Caps are the inputs and features a model accepts, and what it outputs.
type Caps struct {
	Vision   bool `json:"vision"`
	Video    bool `json:"video"`
	Audio    bool `json:"audio"`
	Tools    bool `json:"tools"`
	Thinking bool `json:"thinking"`
	// OutputModalities: what the model produces, spelled by the server ("text", "image",
	// "audio", "video"); empty when it tells nothing (Ollama, a model typed by hand). The three
	// fields above are inputs, on the other side: a model that reads images and writes text has
	// Vision true and OutputModalities ["text"] (#275).
	OutputModalities []string `json:"outputModalities,omitempty"`
	// Known is false when the server could not tell (model not loaded): the page then
	// lets the user try.
	Known bool `json:"known"`
	// Local: the model runs on a llama.cpp server or behind llama-swap, whose chat template
	// reads the reasoning effort of the request at the top of the prompt: the assistant keeps
	// one effort per conversation and writes its changes into the history (#217).
	Local bool `json:"local,omitempty"`
	// SystemTurns: its chat template accepts a system message in the middle of the
	// conversation (DeepSeek's does; Qwen's raises "System message must be at the
	// beginning"). Told by the family of the model, false by default.
	SystemTurns bool `json:"systemTurns,omitempty"`
}

// systemTurns: the families whose template renders a system message anywhere.
func systemTurns(id string) bool {
	return strings.Contains(strings.ToLower(id), "deepseek")
}

// The output modalities, as the servers spell them.
const (
	OutputText  = "text"
	OutputImage = "image"
)

// HasOutput: the model is known to produce this kind of output.
func (c Caps) HasOutput(kind string) bool {
	for _, o := range c.OutputModalities {
		if strings.EqualFold(o, kind) {
			return true
		}
	}
	return false
}

// CanChat: the model writes text. Its outputs are accepted when the server tells none (Ollama,
// a model typed by hand): the lists then show it, like the other unknown capabilities.
func (c Caps) CanChat() bool {
	return len(c.OutputModalities) == 0 || c.HasOutput(OutputText)
}

// CanGenerate: the model makes images, through the images API of its server. Unknown outputs are
// accepted, as in CanChat.
func (c Caps) CanGenerate() bool {
	return len(c.OutputModalities) == 0 || c.HasOutput(OutputImage)
}

type Model struct {
	ID      string `json:"id"`
	Size    int64  `json:"size,omitempty"`
	Details string `json:"details,omitempty"`
	// State: "loaded", "unloaded" or "" when the server does not say.
	State   string `json:"state,omitempty"`
	Context int    `json:"context,omitempty"`
	Caps    Caps   `json:"caps"`
}

type ModelList struct {
	Kind   string  `json:"kind"`
	Models []Model `json:"models"`
}

func (m *Manager) Models(ctx context.Context, serverID string) (*ModelList, error) {
	s, err := m.server(serverID)
	if err != nil {
		return nil, err
	}
	kind := m.kind(ctx, s)
	var models []Model
	switch kind {
	case "ollama":
		models, err = m.ollamaModels(ctx, s)
	case "openai":
		models, err = m.openaiModels(ctx, s)
		if err != nil && len(s.Models) > 0 {
			models, err = nil, nil // no /models: the typed ones
		}
	default:
		models, err = m.llamacppModels(ctx, s)
	}
	if err != nil {
		return nil, err
	}
	models = withTyped(models, s.Models)
	m.mu.Lock()
	local := kind == "llamacpp" || kind == "openai" && m.swaps[s.URL]
	m.mu.Unlock()
	if local {
		for i := range models {
			models[i].Caps.Local = true
			models[i].Caps.SystemTurns = systemTurns(models[i].ID)
		}
	}
	sort.SliceStable(models, func(i, j int) bool { return strings.ToLower(models[i].ID) < strings.ToLower(models[j].ID) })
	return &ModelList{Kind: kind, Models: models}, nil
}

// ---------- llama.cpp (and other OpenAI compatible servers) ----------

// modelEntry is one entry of the "data" of /v1/models, with the fields read by the llama.cpp and
// the OpenAI-compatible decoders: llama-swap and OpenRouter spell what a model outputs the same
// way (architecture.output_modalities, capabilities.image_generation).
type modelEntry struct {
	ID           string `json:"id"`
	OwnedBy      string `json:"owned_by"`
	Context      int    `json:"context_length"`
	Architecture *struct {
		Input  []string `json:"input_modalities"`
		Output []string `json:"output_modalities"`
	} `json:"architecture"`
	Capabilities *struct {
		ImageGeneration bool `json:"image_generation"`
	} `json:"capabilities"`
	Params []string `json:"supported_parameters"`
	Status *struct {
		Value string   `json:"value"`
		Args  []string `json:"args"`
	} `json:"status"`
	Meta *struct {
		NCtx   int   `json:"n_ctx"`
		Params int64 `json:"n_params"`
		Size   int64 `json:"size"`
	} `json:"meta"`
}

// outputs are the modalities the model produces, as the server spells them; empty when it tells
// none. The image_generation flag of llama-swap stands for an image output when no list comes
// with it. Nothing else is guessed: the name of a model never decides its outputs.
func (e *modelEntry) outputs() []string {
	if e.Architecture != nil && len(e.Architecture.Output) > 0 {
		return e.Architecture.Output
	}
	if e.Capabilities != nil && e.Capabilities.ImageGeneration {
		return []string{OutputImage}
	}
	return nil
}

type llamaProps struct {
	Role       string `json:"role"`
	Modalities *struct {
		Vision bool `json:"vision"`
		Video  bool `json:"video"`
		Audio  bool `json:"audio"`
	} `json:"modalities"`
	Caps *struct {
		Tools bool `json:"supports_tools"`
	} `json:"chat_template_caps"`
	Settings struct {
		NCtx int `json:"n_ctx"`
	} `json:"default_generation_settings"`
}

func (p *llamaProps) apply(md *Model) {
	if p.Modalities != nil {
		md.Caps.Vision, md.Caps.Video, md.Caps.Audio = p.Modalities.Vision, p.Modalities.Video, p.Modalities.Audio
		md.Caps.Known = true
	}
	// Without the template capabilities (older servers), tools are assumed available.
	md.Caps.Tools = p.Caps == nil || p.Caps.Tools
	md.Caps.Thinking = true // reasoning_content is shown when the model sends it
	if p.Settings.NCtx > 0 {
		md.Context = p.Settings.NCtx
	}
}

func (m *Manager) llamacppModels(ctx context.Context, s Server) ([]Model, error) {
	var list struct {
		Data []modelEntry `json:"data"`
	}
	if err := m.getJSON(ctx, s, "/v1/models", &list); err != nil {
		return nil, err
	}
	var props llamaProps
	hasProps := m.getJSON(ctx, s, "/props", &props) == nil
	router := hasProps && props.Role == "router"

	models := make([]Model, len(list.Data))
	var wg sync.WaitGroup
	for i, d := range list.Data {
		md := Model{ID: d.ID, Caps: Caps{Tools: true, Thinking: true, OutputModalities: d.outputs()}}
		if d.Meta != nil {
			md.Context, md.Size = d.Meta.NCtx, d.Meta.Size
			if d.Meta.Params > 0 {
				md.Details = humanParams(d.Meta.Params)
			}
		}
		switch {
		case d.Status != nil:
			// Router mode: one entry per preset, loaded on demand. Asking the properties
			// of an unloaded model would load it, so they are guessed from its arguments.
			md.State = d.Status.Value
			if d.Status.Value == "loaded" {
				wg.Add(1)
				go func(i int, md Model) {
					defer wg.Done()
					var p llamaProps
					if m.getJSON(ctx, s, "/props?model="+url.QueryEscape(md.ID), &p) == nil {
						p.apply(&md)
					}
					models[i] = md
				}(i, md)
				continue
			}
			for _, a := range d.Status.Args {
				if a == "--mmproj" || a == "-mm" || a == "--mmproj-url" || a == "-mmu" {
					md.Caps.Vision = true
				}
			}
		case hasProps && !router:
			md.State = "loaded"
			props.apply(&md)
		}
		models[i] = md
	}
	wg.Wait()
	return models, nil
}

func humanParams(n int64) string {
	switch {
	case n >= 1e9:
		return trimFloat(float64(n)/1e9) + "B"
	case n >= 1e6:
		return trimFloat(float64(n)/1e6) + "M"
	}
	return ""
}

func trimFloat(f float64) string {
	prec := 1
	if f >= 100 {
		prec = 0
	}
	return strings.TrimSuffix(strconv.FormatFloat(f, 'f', prec, 64), ".0")
}

// ---------- typed models ----------

// withTyped adds the models typed by the user, whose capabilities win over the listed ones.
// What a typed model outputs comes from the server only (ModelConf knows the inputs): a typed
// entry the server does not list stays unclassified.
func withTyped(models []Model, typed []ModelConf) []Model {
	for _, t := range typed {
		if strings.TrimSpace(t.ID) == "" {
			continue
		}
		md := Model{ID: t.ID, Context: t.Context, Caps: Caps{Tools: t.Tools, Vision: t.Vision, Thinking: t.Thinking, Known: true}}
		found := false
		for i := range models {
			if models[i].ID == t.ID {
				if md.Context == 0 {
					md.Context = models[i].Context
				}
				md.Caps.OutputModalities = models[i].Caps.OutputModalities
				md.Size, md.Details, md.State = models[i].Size, models[i].Details, models[i].State
				models[i], found = md, true
			}
		}
		if !found {
			models = append(models, md)
		}
	}
	return models
}

// ---------- OpenAI-compatible providers ----------

// DefaultContext of a model of a provider that does not tell it.
const DefaultContext = 128000

func (m *Manager) openaiModels(ctx context.Context, s Server) ([]Model, error) {
	// OpenRouter adds the context size and the modalities; llama-swap the state.
	var list struct {
		Data []modelEntry `json:"data"`
	}
	if err := m.getJSON(ctx, s, "/v1/models", &list); err != nil {
		return nil, err
	}
	models := make([]Model, 0, len(list.Data))
	for _, d := range list.Data {
		md := Model{ID: d.ID, Context: d.Context, Caps: Caps{Tools: true, OutputModalities: d.outputs()}}
		if d.OwnedBy == "llama-swap" {
			// Local servers behind llama-swap: reasoning_content is shown when the model sends it.
			md.Caps.Thinking = true
			m.mu.Lock()
			m.swaps[s.URL] = true
			m.mu.Unlock()
		}
		if d.Status != nil {
			md.State = d.Status.Value
		}
		if md.Context == 0 {
			md.Context = m.upstreamContext(ctx, s, md)
		}
		if md.Context == 0 {
			md.Context = DefaultContext
		}
		if d.Architecture != nil {
			md.Caps.Known = true
			for _, in := range d.Architecture.Input {
				md.Caps.Vision = md.Caps.Vision || in == "image"
			}
		}
		if len(d.Params) > 0 {
			md.Caps.Tools = false
			for _, p := range d.Params {
				md.Caps.Tools = md.Caps.Tools || p == "tools"
				md.Caps.Thinking = md.Caps.Thinking || p == "reasoning"
			}
		}
		models = append(models, md)
	}
	return models, nil
}

// upstreamContext is the context of a model behind llama-swap that does not list it (it reads
// only llama-server's --ctx-size): the /props of the loaded server, kept for when it is
// unloaded, across restarts of the pod. An unloaded model is never asked, that would load
// it. 0 when unknown.
func (m *Manager) upstreamContext(ctx context.Context, s Server, md Model) int {
	key := s.URL + "\n" + md.ID
	if md.State == "loaded" || md.State == "ready" {
		var p llamaProps
		if m.getJSON(ctx, s, "/upstream/"+url.PathEscape(md.ID)+"/props", &p) == nil && p.Settings.NCtx > 0 {
			m.mu.Lock()
			if m.contexts[key] != p.Settings.NCtx {
				m.contexts[key] = p.Settings.NCtx
				m.st.WriteJSON(contextsFile, m.contexts)
			}
			m.mu.Unlock()
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.contexts[key]
}

// ---------- Ollama ----------

func (m *Manager) ollamaModels(ctx context.Context, s Server) ([]Model, error) {
	var tags struct {
		Models []struct {
			Name    string `json:"name"`
			Size    int64  `json:"size"`
			Details struct {
				ParameterSize string `json:"parameter_size"`
				Quantization  string `json:"quantization_level"`
			} `json:"details"`
		} `json:"models"`
	}
	if err := m.getJSON(ctx, s, "/api/tags", &tags); err != nil {
		return nil, err
	}
	loaded := map[string]bool{}
	var ps struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if m.getJSON(ctx, s, "/api/ps", &ps) == nil {
		for _, p := range ps.Models {
			loaded[p.Name] = true
		}
	}
	models := make([]Model, len(tags.Models))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, t := range tags.Models {
		details := strings.TrimSpace(t.Details.ParameterSize + " " + t.Details.Quantization)
		md := Model{ID: t.Name, Size: t.Size, Details: details, State: "unloaded"}
		if loaded[t.Name] {
			md.State = "loaded"
		}
		wg.Add(1)
		go func(i int, md Model) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			var show struct {
				Capabilities []string       `json:"capabilities"`
				ModelInfo    map[string]any `json:"model_info"`
			}
			if m.postJSON(ctx, s, "/api/show", map[string]string{"model": md.ID}, &show) == nil {
				md.Caps.Known = true
				for _, c := range show.Capabilities {
					switch c {
					case "vision":
						md.Caps.Vision = true
					case "tools":
						md.Caps.Tools = true
					case "thinking":
						md.Caps.Thinking = true
					case "audio":
						md.Caps.Audio = true
					}
				}
				for k, v := range show.ModelInfo {
					if strings.HasSuffix(k, ".context_length") {
						if f, ok := v.(float64); ok {
							md.Context = int(f)
						}
					}
				}
			}
			models[i] = md
		}(i, md)
	}
	wg.Wait()
	return models, nil
}
