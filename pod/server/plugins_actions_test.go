package server

import (
	"encoding/json"
	"testing"

	"antennae.space/ide/pod/plugins"
)

func TestPluginSettingsAndPolicy(t *testing.T) {
	s, _ := newServer(t)
	m := plugins.Manifest{ID: "db", Contributes: plugins.Contributions{Settings: &plugins.SettingsSchema{Properties: map[string]plugins.Setting{
		"rows": {Type: "number", Title: "Rows", Default: 100.0}, "loud": {Type: "boolean", Title: "Loud"}}}}}
	if v := s.pluginSettingValues(m); v["rows"] != 100.0 || len(v) != 1 {
		t.Fatalf("defaults: %v", v)
	}
	if _, err := s.Settings.Save(json.RawMessage(`{"pluginSettings":{"db":{"rows":5,"other":1}},"pluginAI":{"db":{"main":"ask","prod":"write","dev":"bogus"}}}`), "t"); err != nil {
		t.Fatal(err)
	}
	if v := s.pluginSettingValues(m); v["rows"] != 5.0 || v["other"] != nil {
		t.Fatalf("set, undeclared keys left out: %v", v)
	}
	for target, want := range map[string]string{"main": aiAsk, "prod": aiWrite, "dev": aiRead, "unknown": aiRead} {
		if got := s.aiPolicy("db", target); got != want {
			t.Fatalf("%s: %s, want %s", target, got, want)
		}
	}
	if got := s.aiPolicy("other", "prod"); got != aiRead {
		t.Fatalf("another plugin's policy: %s", got)
	}
	// Targets declared by the backend, kept by the pod.
	e := plugins.External{Manifest: m}
	if _, err := s.backendSettings(e, "ai.targets", json.RawMessage(`{"targets":[{"id":"main","label":"Main DB"}]}`)); err != nil {
		t.Fatal(err)
	}
	if got := s.aiTargets("db"); len(got) != 1 || got[0].Label != "Main DB" {
		t.Fatalf("targets: %v", got)
	}
	if _, err := s.backendSettings(e, "ai.targets", json.RawMessage(`{"targets":[{"id":"","label":"x"}]}`)); err == nil {
		t.Fatal("an empty target")
	}
}
