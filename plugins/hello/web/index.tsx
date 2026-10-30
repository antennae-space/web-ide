// The plugin of the browser tests (pod/plugins/hello): a tool calling its backend, an item of the
// status bar while the tool has the focus, items it adds to the ⋮ menu of its tool, and the editor
// decorations it puts in the file view of Code (editorDecorations #187, on deco.txt).
import { createResource, createSignal } from 'solid-js'
import type { PluginModule } from '@ide/types'
import './deco.css'

/** The file of the browser tests the decorations below apply to (e2e: plugins/code/e2e/decorations.cjs). */
const DECO_FILE = 'deco.txt'

export const hello: PluginModule = {
  activate(api) {
    // "Greet twice": a choice of the menu, read by the tool below.
    const [twice, setTwice] = createSignal(false)
    function HelloTool() {
      const [text] = createResource(() => api.rpc<{ text: string }>('greet', { name: 'plugin' }).then((r) => r.text))
      return (
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">Hello</span>
          </div>
          <div class="panel-body pad" data-testid="hello-text">
            {twice() ? `${text()} ${text()}` : text()}
          </div>
        </div>
      )
    }

    // ---------- editor decorations (editorDecorations, #187) ----------
    const isDeco = (path: string) => path.endsWith('/' + DECO_FILE)
    const [marks, setMarks] = createSignal<{ id: string; line: number }[]>([{ id: 'm1', line: 1 }])
    const [classLine, setClassLine] = createSignal(2)
    const [widgetLine, setWidgetLine] = createSignal(1)
    /** What the last `moved` report said for each mark: shown in its title, read by the test. */
    const [moved, setMoved] = createSignal<Record<string, string>>({})
    let added = 0

    return {
      tools: { hello: { component: HelloTool } },
      toolStatus: { hello: () => [{ id: 'hello', testid: 'status-hello', text: 'Hello', menu: () => [{ label: 'Hi', action: () => {} }] }] },
      toolMenu: {
        hello: () => [
          { label: api.t('Say hello from the menu'), action: () => api.ui.toast(api.t('Hello from the menu')) },
          { label: api.t('Greet twice'), checked: twice(), action: () => setTwice(!twice()) },
        ],
      },
      // One button in the corner of its zone or tile, before the ⋮ (toolCorner, #176).
      toolCorner: {
        hello: () => [<button class="icon-btn" data-testid="hello-corner" title={api.t('Say hello')} onClick={() => api.ui.toast(api.t('Hello from the corner'))} />],
      },
      editorDecorations: {
        gutter: (path) => (isDeco(path) ? marks().map((m) => ({ id: m.id, line: m.line, class: 'deco-mark', title: moved()[m.id] ?? `deco ${m.id}` })) : undefined),
        lines: (path) => (isDeco(path) && classLine() >= 0 ? [{ id: 'ln', line: classLine(), class: 'deco-line' }] : undefined),
        widgets: (path) => (isDeco(path) && widgetLine() >= 0 ? [{ id: 'w', line: widgetLine(), text: '\u2190 deco', class: 'deco-widget', title: 'deco widget' }] : undefined),
        // A click in the lane puts or takes back a mark on the line clicked.
        gutterClick: (path, line) => {
          if (!isDeco(path)) return
          setMarks((prev) => (prev.some((m) => m.line === line) ? prev.filter((m) => m.line !== line) : [...prev, { id: 'u' + ++added, line }]))
        },
        gutterMenu: (path) => (isDeco(path) ? [{ label: api.t('Clear the deco marks'), action: () => setMarks([]) }] : []),
        menu: (path, offset) =>
          isDeco(path)
            ? [
                {
                  label: api.t('Deco: mark the caret line'),
                  action: () => {
                    const d = api.buffers.get(path)
                    if (d) setMarks((prev) => [...prev, { id: 'u' + ++added, line: d.lineAt(offset) }])
                  },
                },
              ]
            : [],
        hover: (path, offset) => {
          const d = isDeco(path) ? api.buffers.get(path) : null
          return d ? { text: `deco hover at line ${d.lineAt(offset) + 1}` } : null
        },
        moved: (path, list) => {
          if (!isDeco(path)) return
          const byId = new Map(list.map((m) => [m.id, m]))
          setMarks((prev) => prev.flatMap((m) => {
            const r = byId.get(m.id)
            if (!r) return [m]
            return r.removed ? [] : [{ ...m, line: r.line }]
          }))
          setMoved((prev) => {
            const next = { ...prev }
            for (const m of list) next[m.id] = m.removed ? `${m.id} removed` : `${m.id} moved to ${m.line}`
            return next
          })
          for (const m of list) {
            if (m.id === 'ln') setClassLine(m.removed ? -1 : m.line)
            else if (m.id === 'w') setWidgetLine(m.removed ? -1 : m.line)
          }
        },
      },
    }
  },
}
