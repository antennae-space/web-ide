package server

import (
	"encoding/json"
	"log"
	"slices"
	"strings"
	"sync"
	"unicode"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/lib/identity"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/store"
)

// The entries of the vault of an external plugin (the grant vault): secrets.json of the pod,
// named plugin:<id>/<key>, so synced with the vault like the other secrets; a plugin reaches its
// own entries only, one by one (no listing).

var vaultMu sync.Mutex

func vaultKey(id, key string) (string, error) {
	if key == "" || len(key) > 200 || strings.IndexFunc(key, unicode.IsControl) >= 0 {
		return "", i18n.Errorf("invalid vault key: %q", key)
	}
	return "plugin:" + id + "/" + key, nil
}

func (s *Server) pluginVault(e plugins.External, method string, params json.RawMessage) (any, error) {
	if !slices.Contains(e.Grants, "vault") {
		return nil, i18n.Errorf("%s is not granted to %s", "vault", e.Manifest.Name)
	}
	a, err := bind[struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}](params)
	if err != nil {
		return nil, err
	}
	k, err := vaultKey(e.Manifest.ID, a.Key)
	if err != nil {
		return nil, err
	}
	vaultMu.Lock()
	defer vaultMu.Unlock()
	all := map[string]json.RawMessage{}
	if err := s.Store.ReadJSON("secrets.json", &all); err != nil && !store.IsNotExist(err) {
		return nil, err
	}
	switch method {
	case "vault.get":
		var v string
		if raw, ok := all[k]; ok {
			_ = json.Unmarshal(raw, &v)
			return map[string]any{"value": v, "found": true}, nil
		}
		return map[string]any{"value": "", "found": false}, nil
	case "vault.set":
		raw, _ := json.Marshal(a.Value)
		all[k] = raw
	default:
		delete(all, k)
	}
	if err := s.Store.WriteJSON("secrets.json", all); err != nil {
		return nil, err
	}
	s.vaultChanged()
	return map[string]any{}, nil
}

// vaultChanged sends the vault to the other pods of the account when it is synced.
func (s *Server) vaultChanged() {
	if s.Sync == nil {
		return
	}
	if src := s.Sync.Source(identity.KindVault); src != nil {
		go func() {
			if err := src.Push(); err != nil {
				log.Printf("vault sync: %v", err)
			}
		}()
	}
}
