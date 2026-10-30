package debug

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"strings"

	"antennae.space/ide/pod/runtime"
)

// The debug configurations (#188, docs/design/debug.md): `.ide/debug.json` of the main project,
// apart from the saved commands. Past name, type and request, the fields are the adapter's own
// and are passed through (the shape of VS Code's launch.json). `.ide` is git-ignored: a
// configuration belongs to one machine.

// ConfigFile is the file itself.
type ConfigFile struct {
	Configurations []map[string]any `json:"configurations"`
}

// Config is one configuration: a name, an adapter type, a request (launch | attach | listen) and
// the fields of the adapter.
type Config struct {
	Name    string
	Type    string
	Request string
	Fields  map[string]any
}

// Name of a configuration, its type, its request.
func (c Config) field(name string) string {
	if v, ok := c.Fields[name].(string); ok {
		return v
	}
	return ""
}

// MarshalJSON writes a configuration as the file holds it: name, type, request, then the
// fields of the adapter.
func (c Config) MarshalJSON() ([]byte, error) {
	out := map[string]any{}
	for k, v := range c.Fields {
		out[k] = v
	}
	out["name"], out["type"], out["request"] = c.Name, c.Type, c.Request
	return json.Marshal(out)
}

// readConfigs reads .ide/debug.json of the main project (an empty file when there is none).
func readConfigs(rt *runtime.Runtime) ([]Config, error) {
	data, err := rt.FS.Read(configPath(rt))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var f ConfigFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	var out []Config
	for _, raw := range f.Configurations {
		c := Config{Fields: raw}
		c.Name, c.Type, c.Request = c.field("name"), c.field("type"), c.field("request")
		if c.Name == "" || c.Type == "" {
			continue
		}
		if c.Request == "" {
			c.Request = "launch"
		}
		out = append(out, c)
	}
	return out, nil
}

// saveConfigs writes .ide/debug.json (the Debug tool edits it as text; the templates fill it).
func saveConfigs(rt *runtime.Runtime, list []map[string]any) error {
	data, err := json.MarshalIndent(ConfigFile{Configurations: list}, "", "  ")
	if err != nil {
		return err
	}
	if err := rt.FS.Mkdir(rt.IdeDir); err != nil && !os.IsExist(err) {
		return err
	}
	return rt.FS.Write(configPath(rt), append(data, '\n'))
}

// addConfig appends a configuration to .ide/debug.json (a template chosen in Run › Debug…), its
// name made unique, and answers it as the file now holds it.
func addConfig(rt *runtime.Runtime, cfg map[string]any) (map[string]any, error) {
	var list []map[string]any
	if data, err := rt.FS.Read(configPath(rt)); err == nil {
		var f ConfigFile
		if err := json.Unmarshal(data, &f); err != nil {
			return nil, err
		}
		list = f.Configurations
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	base, _ := cfg["name"].(string)
	if base == "" {
		base = "Debug"
	}
	taken := map[string]bool{}
	for _, c := range list {
		if n, ok := c["name"].(string); ok {
			taken[n] = true
		}
	}
	name := base
	for i := 2; taken[name]; i++ {
		name = fmt.Sprintf("%s %d", base, i)
	}
	cfg["name"] = name
	if err := saveConfigs(rt, append(list, cfg)); err != nil {
		return nil, err
	}
	return cfg, nil
}

// configPath is .ide/debug.json of the main project.
func configPath(rt *runtime.Runtime) string { return path.Join(rt.IdeDir, "debug.json") }

// substitute replaces the variables of a configuration. A value of a map that is one variable
// keeps its type (a port stays a number); the items of a list stay strings.
func substitute(v any, vars map[string]string) any {
	switch t := v.(type) {
	case string:
		return substituteString(t, vars, true)
	case map[string]any:
		for k, e := range t {
			t[k] = substitute(e, vars)
		}
	case []any:
		for i, e := range t {
			t[i] = substituteList(e, vars)
		}
	}
	return v
}

// substituteList substitutes inside a list item, which stays a string.
func substituteList(v any, vars map[string]string) any {
	switch t := v.(type) {
	case string:
		return substituteString(t, vars, false)
	case map[string]any:
		for k, e := range t {
			t[k] = substitute(e, vars)
		}
	case []any:
		for i, e := range t {
			t[i] = substituteList(e, vars)
		}
	}
	return v
}

// substituteString replaces ${workspaceFolder}, ${file}, ${fileDirname} and ${env:NAME}.
func substituteString(s string, vars map[string]string, number bool) any {
	if strings.HasPrefix(s, "${") && strings.HasSuffix(s, "}") {
		if v, ok := lookup(s[2:len(s)-1], vars); ok {
			if number && looksNumeric(v) {
				if n, err := json.Number(v).Float64(); err == nil {
					return n
				}
			}
			return v
		}
	}
	out := s
	for name, value := range vars {
		out = strings.ReplaceAll(out, "${"+name+"}", value)
	}
	for {
		i := strings.Index(out, "${env:")
		if i < 0 {
			break
		}
		end := strings.Index(out[i:], "}")
		if end < 0 {
			break
		}
		name := out[i+len("${env:") : i+end]
		value, _ := lookup("env:"+name, vars)
		out = out[:i] + value + out[i+end+1:]
	}
	return out
}

// lookup is the value of one variable name ("" and false when it is unknown).
func lookup(name string, vars map[string]string) (string, bool) {
	if rest, ok := strings.CutPrefix(name, "env:"); ok {
		return os.Getenv(rest), true
	}
	v, ok := vars[name]
	return v, ok
}

// looksNumeric tells that a value is a plain number (a port, a pid), not a date or a version.
func looksNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
