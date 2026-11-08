package llm

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"antennae.space/ide/lib/i18n"
)

// ImageTimeout bounds a generation: behind llama-swap on one GPU it unloads the model of the
// conversation and loads the image model first, which can take minutes.
var ImageTimeout = 10 * time.Minute

// MaxImageBytes bounds the image read from the server.
const MaxImageBytes = 20 << 20

// GenerateImage asks a server for one image (OpenAI images API): /v1/images/generations from
// the prompt, or /v1/images/edits when edit holds an image to change. It returns the image
// file (PNG for the local servers). Not through the relay: the tool runs in the pod.
func (m *Manager) GenerateImage(ctx context.Context, serverID, model, prompt, size string, edit []byte) ([]byte, error) {
	s, err := m.server(serverID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, ImageTimeout)
	defer cancel()
	var body bytes.Buffer
	var ctype, path string
	if edit == nil {
		path, ctype = "/v1/images/generations", "application/json"
		req := map[string]any{"model": model, "prompt": prompt, "n": 1, "response_format": "b64_json"}
		if size != "" {
			req["size"] = size
		}
		_ = json.NewEncoder(&body).Encode(req)
	} else {
		path = "/v1/images/edits"
		w := multipart.NewWriter(&body)
		for k, v := range map[string]string{"model": model, "prompt": prompt, "n": "1", "response_format": "b64_json", "size": size} {
			if v != "" {
				_ = w.WriteField(k, v)
			}
		}
		f, _ := w.CreateFormFile("image", "image.png")
		_, _ = f.Write(edit)
		_ = w.Close()
		ctype = w.FormDataContentType()
	}
	var out struct {
		Data []struct {
			B64 string `json:"b64_json"`
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := m.sendRaw(ctx, s, http.MethodPost, path, ctype, &body, &out); err != nil {
		return nil, err
	}
	if len(out.Data) == 0 {
		return nil, i18n.New("the server returned no image")
	}
	d := out.Data[0]
	if d.B64 != "" {
		return base64.StdEncoding.DecodeString(strings.TrimSpace(d.B64))
	}
	if d.URL == "" {
		return nil, i18n.New("the server returned no image")
	}
	// A server that answers a URL only: fetch it once.
	resp, err := m.sendRawResponse(ctx, Server{URL: d.URL}, http.MethodGet, "", "", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, MaxImageBytes))
}

// sendRaw sends a body already encoded and decodes the JSON answer into v.
func (m *Manager) sendRaw(ctx context.Context, s Server, method, path, ctype string, body io.Reader, v any) error {
	resp, err := m.sendRawResponse(ctx, s, method, path, ctype, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(io.LimitReader(resp.Body, 2*MaxImageBytes)).Decode(v)
}

func (m *Manager) sendRawResponse(ctx context.Context, s Server, method, path, ctype string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, s.URL+path, body)
	if err != nil {
		return nil, err
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	if s.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+s.APIKey)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, i18nReach(s, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, httpError(resp, data)
	}
	return resp, nil
}
