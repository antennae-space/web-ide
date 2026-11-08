package ai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/plugins/ai/llm"
	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/fsx"
)

func TestGenerateImageTool(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	var edited string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f, _, err := r.FormFile("image"); err == nil {
			data, _ := io.ReadAll(f)
			edited = string(data)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(png)}}})
	}))
	defer srv.Close()
	dir := t.TempDir()
	s, _ := newTestA(t, dir)
	rt := testRuntime(t, dir)
	rt.FS = fsx.Local{}
	r := &assistantRun{id: "c", ctx: context.Background(), chat: &engine.Chat{}}
	args := func(js string) assistant.Args {
		var a assistant.Args
		if err := json.Unmarshal([]byte(js), &a); err != nil {
			t.Fatal(err)
		}
		return a
	}
	offered := func() bool {
		for _, d := range s.offered(rt, engine.ToolsFor(engine.Build, nil, false, false, false)) {
			if strings.Contains(string(d), `"generate_image"`) {
				return true
			}
		}
		return false
	}
	if offered() {
		t.Fatal("generate_image offered without an image model")
	}
	if _, err := s.generateImage(r, rt, engine.Build, args(`{"title":"x","prompt":"a fox"}`)); err == nil || !strings.Contains(err.Error(), "no image model") {
		t.Fatalf("without a model: %v", err)
	}
	if err := s.LLM.SaveServer(llm.Server{ID: "img", Kind: "openai", URL: srv.URL}, false); err != nil {
		t.Fatal(err)
	}
	if err := s.LLM.SetImageDefault("img", "Z-Image-Turbo"); err != nil {
		t.Fatal(err)
	}
	if !offered() {
		t.Fatal("generate_image not offered with an image model")
	}
	for _, d := range engine.ToolsFor(engine.Orchestrator, nil, false, false, false) {
		if strings.Contains(string(d), `"generate_image"`) {
			t.Fatal("generate_image offered to the Orchestrator")
		}
	}
	_ = os.WriteFile(filepath.Join(dir, "logo.svg"), []byte("<svg/>"), 0o644)
	for js, want := range map[string]string{
		`{"title":"x","prompt":""}`:                       "prompt is missing",
		`{"title":"x","prompt":"p","size":"big"}`:         "WIDTHxHEIGHT",
		`{"title":"x","prompt":"p","path":"fox.jpg"}`:     "a .png file",
		`{"title":"x","prompt":"p","path":"../out.png"}`:  "outside the project",
		`{"title":"x","prompt":"p","edit":"3"}`:           "page 3 does not exist",
		`{"title":"x","prompt":"p","edit":"logo.svg"}`:    "png, jpg, webp or gif",
		`{"title":"x","prompt":"p","edit":"../a.png"}`:    "outside the project",
		`{"title":"x","prompt":"p","path":"img/fox.png"}`: "needs an IDE window open", // generated and saved; no window draws the page
	} {
		if _, err := s.generateImage(r, rt, engine.Build, args(js)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", js, err)
		}
	}
	if data, err := os.ReadFile(filepath.Join(dir, "img", "fox.png")); err != nil || string(data) != string(png) {
		t.Fatalf("saved image: %q %v", data, err)
	}
	// Out of Build mode, the scratch folder only.
	if _, err := s.generateImage(r, rt, engine.Plan, args(`{"title":"x","prompt":"p","path":"fox.png"}`)); err == nil || !strings.Contains(err.Error(), "scratch folder") {
		t.Fatalf("Plan mode: %v", err)
	}
	// A page of the board is sent to the edits endpoint.
	src := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("page-one"))
	r.chat.Messages = []*engine.Message{{Role: "user", Content: json.RawMessage(`[{"type":"image_url","image_url":{"url":"` + src + `"}}]`),
		Attachments: json.RawMessage(`[{"name":"cat.png","kind":"image","w":4,"h":3}]`)}}
	if _, err := s.generateImage(r, rt, engine.Build, args(`{"title":"x","prompt":"make it blue","edit":"1"}`)); err == nil || !strings.Contains(err.Error(), "needs an IDE window open") {
		t.Fatalf("edit of a page: %v", err)
	}
	if edited != "page-one" {
		t.Fatalf("image sent for the edit: %q", edited)
	}
}
