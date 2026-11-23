package server

import (
	"context"
	"net/url"
	"os/exec"
	"regexp"
	"strings"

	"antennae.space/ide/pod/projects"
)

var githubName = regexp.MustCompile(`^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+$`)

// Send only the repository name to the home page. Origin URLs can contain credentials.
func projectRepositories(ctx context.Context, list []projects.View) map[string]string {
	repos := map[string]string{}
	for _, p := range list {
		if ctx.Err() != nil {
			break
		}
		if p.Type != "local" {
			continue
		}
		cmd := exec.CommandContext(ctx, "git", "-C", p.Path, "config", "--local", "--get", "remote.origin.url")
		if raw, err := cmd.Output(); err == nil {
			if repo := githubRepository(strings.TrimSpace(string(raw))); repo != "" {
				repos[p.ID] = repo
			}
		}
	}
	return repos
}

func githubRepository(remote string) string {
	path, scp := strings.CutPrefix(remote, "git@github.com:")
	if !scp {
		u, err := url.Parse(remote)
		if err != nil || !strings.EqualFold(u.Hostname(), "github.com") {
			return ""
		}
		switch u.Scheme {
		case "http", "https", "ssh", "git":
			path = strings.TrimPrefix(u.Path, "/")
		default:
			return ""
		}
	}
	path = strings.TrimSuffix(strings.TrimSuffix(path, "/"), ".git")
	if !githubName.MatchString(path) || strings.HasSuffix(path, "/..") || strings.HasSuffix(path, "/.") {
		return ""
	}
	return path
}
