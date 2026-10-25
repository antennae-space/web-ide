package server

import (
	"encoding/json"
	"net/url"
	"slices"
	"strings"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/push"
	"antennae.space/ide/pod/runtime"
)

// pluginNotify runs notify {kind, query?, tag?, urgency?, texts: {lang: {title, body}}} for a
// backend (grant notify, #156): a push notification of the pod of one of the kinds the devices
// choose from (push.Kinds), opening its project (query: the parameters of its address, a link
// of the plugin), its tag kept to the plugin.
func (s *Server) pluginNotify(rt *runtime.Runtime, e plugins.External, params json.RawMessage) (any, error) {
	if !slices.Contains(e.Grants, "notify") {
		return nil, i18n.Errorf("%s is not granted to %s", "notify", e.Manifest.Name)
	}
	var a struct {
		Kind    string `json:"kind"`
		Query   string `json:"query"`
		Tag     string `json:"tag"`
		Urgency string `json:"urgency"`
		Texts   map[string]struct {
			Title string `json:"title"`
			Body  string `json:"body"`
		} `json:"texts"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	if !slices.Contains(push.Kinds, a.Kind) {
		return nil, i18n.Errorf("unknown kind of notification: %s", a.Kind)
	}
	en, ok := a.Texts["en"]
	if !ok || en.Title == "" {
		return nil, i18n.New("a notification needs its English title")
	}
	if a.Urgency != "high" && a.Urgency != "low" {
		a.Urgency = "normal"
	}
	path := "/project/" + url.PathEscape(rt.P.ID)
	if q := strings.TrimPrefix(a.Query, "?"); q != "" {
		v, err := url.ParseQuery(q)
		if err != nil {
			return nil, err
		}
		path += "?" + v.Encode()
	}
	clip := func(t string, n int) string {
		if len(t) > n {
			return t[:n]
		}
		return t
	}
	texts := a.Texts
	go s.notify(plugins.Note{Kind: a.Kind, Path: path, Tag: "plugin-" + e.Manifest.ID + "-" + clip(a.Tag, 100), Urgency: a.Urgency,
		Text: func(lang string) (string, string) {
			t, ok := texts[lang]
			if !ok || t.Title == "" {
				t = texts["en"]
			}
			return clip(t.Title, 200), clip(t.Body, 1000)
		}})
	return map[string]any{}, nil
}
