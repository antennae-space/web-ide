package projects

import "testing"

func TestGitHubRepository(t *testing.T) {
	for remote, want := range map[string]string{
		"git@github.com:team/repo.git":                 "team/repo",
		"ssh://git@github.com/team/repo.git":           "team/repo",
		"https://user:secret@github.com/team/repo.git": "team/repo",
		"https://github.com.example.org/team/repo.git": "",
		"https://github.com/team/repo/tree/main":       "",
		"https://github.com/team/..":                   "",
		"file:///home/git/repo.git":                    "",
	} {
		if got := githubRepository(remote); got != want {
			t.Errorf("githubRepository(%q) = %q, want %q", remote, got, want)
		}
	}
}
