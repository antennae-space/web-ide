package llm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGenerateImage(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\nfake")
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = map[string]string{"path": r.URL.Path, "auth": r.Header.Get("Authorization")}
		switch r.URL.Path {
		case "/v1/images/generations":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			got["model"], got["prompt"], got["size"] = body["model"].(string), body["prompt"].(string), body["size"].(string)
		case "/v1/images/edits":
			f, _, err := r.FormFile("image")
			if err != nil {
				t.Errorf("edit without image: %v", err)
				return
			}
			data, _ := io.ReadAll(f)
			got["model"], got["prompt"], got["image"] = r.FormValue("model"), r.FormValue("prompt"), string(data)
		default:
			http.Error(w, `{"error":{"message":"no such model"}}`, http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(png)}}})
	}))
	defer srv.Close()
	m, id := newManager(t, srv.URL, "openai")
	if s, _ := m.ImageDefault(); s != "" {
		t.Fatal("an image model before any choice")
	}
	if err := m.SetImageDefault(id, "Z-Image-Turbo"); err != nil {
		t.Fatal(err)
	}
	if s, md := m.ImageDefault(); s != id || md != "Z-Image-Turbo" {
		t.Fatalf("default %q %q", s, md)
	}
	data, err := m.GenerateImage(context.Background(), id, "Z-Image-Turbo", "a red fox", "512x512", nil)
	if err != nil || string(data) != string(png) {
		t.Fatalf("generation: %q %v", data, err)
	}
	if got["path"] != "/v1/images/generations" || got["model"] != "Z-Image-Turbo" || got["prompt"] != "a red fox" || got["size"] != "512x512" || got["auth"] != "Bearer k" {
		t.Fatalf("generation request: %v", got)
	}
	if _, err := m.GenerateImage(context.Background(), id, "Qwen-Image", "make it blue", "", []byte("source")); err != nil {
		t.Fatal(err)
	}
	if got["path"] != "/v1/images/edits" || got["image"] != "source" || got["prompt"] != "make it blue" || got["model"] != "Qwen-Image" {
		t.Fatalf("edit request: %v", got)
	}
	// The server deleted: no image model any more.
	if err := m.DeleteServer(id); err != nil {
		t.Fatal(err)
	}
	if s, _ := m.ImageDefault(); s != "" {
		t.Fatal("image model of a deleted server")
	}
}

func TestGenerateImageErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "edits") {
			_, _ = w.Write([]byte(`{"data":[]}`))
			return
		}
		http.Error(w, `{"error":{"message":"model not found"}}`, http.StatusBadRequest)
	}))
	defer srv.Close()
	m, id := newManager(t, srv.URL, "openai")
	if _, err := m.GenerateImage(context.Background(), id, "x", "p", "", nil); err == nil || !strings.Contains(err.Error(), "model not found") {
		t.Fatalf("error of the server: %v", err)
	}
	if _, err := m.GenerateImage(context.Background(), id, "x", "p", "", []byte("i")); err == nil || !strings.Contains(err.Error(), "no image") {
		t.Fatalf("empty answer: %v", err)
	}
}
