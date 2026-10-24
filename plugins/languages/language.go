package languages

import (
	"context"
	"encoding/json"

	"antennae.space/ide/pod/caps"
	"antennae.space/ide/pod/plugins"

	"antennae.space/ide/plugins/languages/internal/lsp"
	"antennae.space/ide/pod/runtime"
)

// servers is the part of a runtime holding its language servers: they stop with the project,
// and a while after its last window left.
type servers struct{ *lsp.Manager }

func (s servers) Stop(bool) { s.StopAll() }
func (s servers) Idle()     { s.StopAll() }

// pod is the pod the plugin runs in: the language packs installed (#145).
var pod plugins.Pod

// packSpecs are the languages of the packs the project of rt uses (all of them for nil).
func packSpecs(rt *runtime.Runtime) []lsp.Spec {
	if pod == nil {
		return nil
	}
	var out []lsp.Spec
	for _, l := range pod.PackLanguages(rt) {
		out = append(out, lsp.PackSpec(l))
	}
	return out
}

// serversOf are the language servers of the project of rt, made on first use: the defaults
// and those of its packs, started by the pod (confined here, on the host over SSH).
func serversOf(rt *runtime.Runtime) *lsp.Manager {
	return rt.Part("languages", func() any {
		exists := func(p string) bool { _, err := rt.FS.Stat(p); return err == nil }
		m := lsp.NewManager(rt.Runner, rt.Root, rt.Local, rt.Config.LSP, exists, rt.Emit)
		m.UsePacks(func() []lsp.Spec { return packSpecs(rt) }, func(pack string, sv plugins.LanguageServer) ([]string, error) {
			return pod.PackCommand(rt, pack, sv)
		})
		return servers{m}
	}).(servers).Manager
}

// language is the language capability (caps.Language) the plugin provides.
type language struct{}

func (language) LangOf(p string) string     { return lsp.LangOf(p) }
func (language) URI(p string) string        { return lsp.URI(p) }
func (language) LanguageID(p string) string { return lsp.LanguageID(p) }

func (language) Notify(rt *runtime.Runtime, lang, method string, params json.RawMessage) error {
	return serversOf(rt).Notify(lang, method, params)
}

func (language) Request(ctx context.Context, rt *runtime.Runtime, lang, method string, params json.RawMessage) (json.RawMessage, error) {
	return serversOf(rt).Request(ctx, lang, method, params)
}

func (language) Diagnostics(rt *runtime.Runtime, uri string) ([]caps.Diagnostic, int) {
	return serversOf(rt).Diagnostics(uri)
}

func (language) AllDiagnostics(rt *runtime.Runtime) map[string][]caps.Diagnostic {
	return serversOf(rt).AllDiagnostics()
}
