# Code plugin

Locked (`required`): the file editor, the default view of a text buffer. A built-in plugin: [plugins.md](../../docs/design/plugins.md); `plugin.json` is its manifest.

- **Pod** (`*.go`, package `code`): No method: the files and buffers are the core's.
- **Page** (`web/`, the chunk `plugin-code`): `FileEditor.tsx`, the view of the file tabs, its change markers and the popup of their hunk (`HunkPopup.tsx`); it reads the `editorDecorations` of the other plugins (marks in the gutter, classes on lines, widgets, hovers, menu items, #187); `ImageView.tsx`, the view of a binary buffer that is an image (png, jpg, webp, gif; SVG stays text): read by `fs.image`, fitted to the pane or at its actual size on a click, read again when its folder changes on disk (#226); `status.ts`, its items of the status bar.
- **E2e** (`e2e/`, run by `e2e/run.sh`): editor, decorations.

The page module imports the plugin API only (`@ide/api`, `@ide/types`, `@ide/capabilities`); the Go package imports the core of `pod/`.
