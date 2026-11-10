package runtime

import (
	"os"
	"path/filepath"
	"testing"

	"antennae.space/ide/pod/fsx"
)

func TestCopy(t *testing.T) {
	root := t.TempDir()
	r := &Runtime{Root: root, FS: fsx.Local{}}
	write := func(p, s string) {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, p), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	read := func(p string) string {
		b, err := os.ReadFile(filepath.Join(root, p))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	write("a.txt", "A")
	write("src/x/y.go", "Y")
	os.Symlink(filepath.Join(root, "src"), filepath.Join(root, "src", "loop"))

	if err := r.Copy(root+"/a.txt", root+"/b.txt"); err != nil || read("b.txt") != "A" {
		t.Fatalf("a file: %v", err)
	}
	if err := r.Copy(root+"/src", root+"/dst"); err != nil || read("dst/x/y.go") != "Y" {
		t.Fatalf("a folder: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(root, "dst", "loop")); err == nil {
		t.Fatal("a linked folder is skipped")
	}
	if r.Copy(root+"/a.txt", root+"/b.txt") == nil {
		t.Fatal("an existing destination is refused")
	}
	if r.Copy(root+"/src", root+"/src/x/again") == nil {
		t.Fatal("a folder into itself is refused")
	}
	if r.Copy(root+"/a.txt", filepath.Dir(root)+"/out.txt") == nil {
		t.Fatal("a copy outside the project is refused")
	}
}
