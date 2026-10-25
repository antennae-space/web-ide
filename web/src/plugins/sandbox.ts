// The sandbox API of an external plugin (docs/design/plugins.md, *Sandboxed views*): its views
// run in an <iframe sandbox="allow-scripts"> (an opaque origin) whose CSP forbids the network;
// one MessageChannel per frame carries what they may ask. The page is the boundary: a method of
// the core needs its grant, an event must be of the plugin's namespace.
import { on, request } from '../pod/rpc'
import { openFile, openTab, mutate, type TabState } from '../state/project'
import { toast } from '../ui/toast'
import { copyText } from '../ui/clipboard'
import { capability } from './capabilities'
import { lang, t } from '../i18n'
import type { FrameCall, PageMessage, SandboxEditorState, SandboxTheme } from './sandbox-api'

/** The CSP of a frame: inline scripts and styles, images as data, no network at all. */
export const frameCSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'"

/**
 * The bootstrap run in the frame before the plugin's module: `ide`, the API the module calls
 * (register, rpc, on, openFile, openView, setViewState, t, tn, toast, theme, editor, settings), over the port the
 * page sends once. Plain ES2020, no import.
 */
export const bootstrap = `(() => {
  let port, info = null, registered = false, mounted = false
  let views = {}, commands = {}
  const pending = new Map(), handlers = {}, themeFns = []
  // The editor of the tab: its state pushed by the page, and the listeners of the view.
  let ed = null
  const edFns = { change: [], selection: [], keys: {} }
  const settingsFns = []
  let next = 1
  // What the module sends before the page gives the channel (a call at load) waits for it.
  const queue = []
  const send = (m) => (port ? port.postMessage(m) : queue.push(m))
  const call = (m) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); send({ ...m, id }) })
  // What crosses the channel is plain JSON: a store of the plugin (a Proxy) cannot be cloned.
  const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
  const fill = (s, p) => (p ? s.replace(/\\{(\\w+)\\}/g, (m, k) => (k in p ? String(p[k]) : m)) : s)
  const applyTheme = (th) => {
    for (const [k, v] of Object.entries(th || {})) document.documentElement.style.setProperty(k, v)
    themeFns.forEach((f) => f(th))
  }
  const ide = {
    register(c) { views = (c && c.views) || {}; commands = (c && c.commands) || {}; registered = true; start() },
    get view() { return info && info.view },
    get lang() { return info && info.lang },
    get theme() { return info && info.theme },
    rpc: (method, params) => call({ call: 'rpc', method, params: plain(params) }),
    on(event, f) { (handlers[event] = handlers[event] || []).push(f); send({ call: 'on', event }) },
    openFile: (path, line) => send({ call: 'openFile', path, line }),
    openView: (view, state, title, key) => send({ call: 'openView', view, state: plain(state), title, key }),
    setViewState: (state) => send({ call: 'setViewState', state: plain(state) }),
    toast: (text, kind) => send({ call: 'toast', text: String(text), kind }),
    copyText: (text) => send({ call: 'copyText', text: String(text) }),
    showConsole: (id) => send({ call: 'showConsole', id: String(id) }),
    t: (k, p) => fill((info && info.catalog && info.catalog[k]) || k.slice(k.indexOf('|') + 1), p),
    tn: (n, one, other, p) => ide.t(n === 1 ? one : other, { n, ...p }),
    onTheme: (f) => themeFns.push(f),
    get settings() { return (info && info.settings) || {} },
    onSettings: (f) => settingsFns.push(f),
    get editor() {
      if (!ed) return null
      return {
        text: () => ed.text,
        selection: () => ({ from: ed.from, to: ed.to, text: ed.text.slice(Math.min(ed.from, ed.to), Math.max(ed.from, ed.to)) }),
        setText: (text) => send({ call: 'editorSet', text: String(text) }),
        insert: (text) => send({ call: 'editorInsert', text: String(text) }),
        mark: (range) => send({ call: 'editorMark', range: range || null }),
        focus: () => send({ call: 'editorFocus' }),
        setWords: (words) => send({ call: 'editorWords', words: (words || []).map(String) }),
        onChange: (f) => edFns.change.push(f),
        onSelection: (f) => edFns.selection.push(f),
        onKey: (name, f) => ((edFns.keys[name] = edFns.keys[name] || []).push(f)),
      }
    },
  }
  window.ide = ide
  function start() {
    if (!info || !registered || mounted) return
    mounted = true
    const v = info.view && views[info.view.id]
    if (v) v(document.getElementById('root'), ide)
    send({ call: 'ready' })
  }
  function receive(e) {
    const m = e.data || {}
    if (m.init) { info = m.init; ed = info.editor || null; applyTheme(info.theme); start(); return }
    if (m.reply && pending.has(m.reply)) {
      const p = pending.get(m.reply); pending.delete(m.reply)
      if ('error' in m) p.reject(Object.assign(new Error(m.error), m.code ? { code: m.code, data: m.data || {} } : {})); else p.resolve(m.result)
      return
    }
    if (m.theme) { info.theme = m.theme; applyTheme(m.theme) }
    if (m.lang) { info.lang = m.lang; info.catalog = m.catalog }
    if (m.event) (handlers[m.event] || []).forEach((f) => f(m.data))
    if (m.command && commands[m.command]) commands[m.command](ide)
    if (m.editor) {
      const was = ed
      ed = m.editor
      if (!was || was.text !== ed.text) edFns.change.forEach((f) => f(ed.text))
      if (!was || was.from !== ed.from || was.to !== ed.to) edFns.selection.forEach((f) => f({ from: ed.from, to: ed.to }))
    }
    if (m.editorKey) (edFns.keys[m.editorKey] || []).forEach((f) => f())
    if (m.settings) { info.settings = m.settings; settingsFns.forEach((f) => f(m.settings)) }
  }
  window.addEventListener('message', (e) => {
    if (e.source !== parent || port || !e.ports[0]) return
    port = e.ports[0]
    port.onmessage = receive
    queue.splice(0).forEach((m) => port.postMessage(m))
  })
  // The shortcuts of the IDE work from the frame: the keys with a modifier, Escape and F1-F12.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Escape' || /^F\\d+$/.test(e.key))
      send({ call: 'key', key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey })
  })
  window.addEventListener('focus', () => send({ call: 'focus' }))
})()`

/** The theme of the IDE as CSS variables: those the page set on its root, and its `color-scheme`. */
export function themeVars(): SandboxTheme {
  const out: SandboxTheme = {}
  const s = document.documentElement.style
  for (let i = 0; i < s.length; i++) {
    const k = s[i]
    if (k.startsWith('--') || k === 'color-scheme') out[k] = s.getPropertyValue(k)
  }
  return out
}

/**
 * The room the IDE's own buttons take over the top right corner of a frame (the "Open in a
 * window" of a zone, the corner of a tile), as `--ide-head-inset`: a built-in tool leaves it in
 * its header, the kit of the plugin SDK does it for a frame.
 */
export function headInset(frame: HTMLElement): string {
  const f = frame.getBoundingClientRect()
  let inset = 0
  for (const el of frame.closest('.zone, .pane')?.querySelectorAll<HTMLElement>(':scope > .detach, .tile-corner') ?? []) {
    const b = el.getBoundingClientRect()
    if (!b.width || b.bottom <= f.top || b.top >= f.top + 40 || b.left >= f.right || b.right <= f.left) continue
    inset = Math.max(inset, Math.ceil(f.right - b.left + 4))
  }
  return `${inset}px`
}

const escapeHTML = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The document of a frame: its CSP, the base styles from the theme, the bootstrap, the module. */
export function frameDoc(js: string): string {
  // A </script> in the module would end its element: written as <\/script>, the same in JS.
  const module = js.replace(/<\/(script)/gi, '<\\/$1')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHTML(frameCSP)}">
<style>html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:var(--font-ui,sans-serif);font-size:var(--font-size-ui,13px)}#root{height:100%;overflow:auto}</style>
<script>${bootstrap}</script></head><body><div id="root"></div><script type="module">${module}</script></body></html>`
}

/** What the page knows of the frame it serves. */
export type FrameHost = {
  plugin: string
  name: string
  /** Its grants now: a grant revoked in Settings is refused at once. */
  grants: () => string[]
  catalogs: Record<string, Record<string, string>>
  /** The view of the frame ("" for the hidden one of the commands) and its tab (a tab view). */
  view: string
  tab?: TabState
  onReady?: () => void
  /** The editor of the tab (a tab view whose manifest asks it). */
  editor?: FrameEditor
  /** Its settings now (the defaults where the user set nothing). */
  settings?: () => Record<string, unknown>
}

/** What the page does for the frame on the editor of its tab. */
export interface FrameEditor {
  state(): SandboxEditorState
  setText(text: string): void
  insert(text: string): void
  mark(range: [number, number] | null): void
  focus(): void
  setWords(words: string[]): void
}

/** The largest text of an editor pushed to a frame. */
const maxEditorText = 1 << 20

/**
 * Serves a frame: sends it its port once loaded, then answers what it asks within its grants.
 * Returns the function that sends it a message and the one that stops serving it.
 */
export function serveFrame(frame: HTMLIFrameElement, host: FrameHost) {
  // A frame moved in the page loads again: each load gets a new channel.
  let port: MessagePort | undefined
  let offs: (() => void)[] = []
  const catalog = () => host.catalogs[lang()] ?? {}
  const handle = (port: MessagePort) => (e: MessageEvent) => {
    const reply = (id: number, r: { result?: unknown; error?: string; code?: string; data?: Record<string, string> }) => port.postMessage({ reply: id, ...r } satisfies PageMessage)
    // Typed as the API says, checked as untrusted: the frame may send anything.
    const m = (e.data ?? {}) as FrameCall
    switch (m.call) {
      case 'rpc': {
        const method = String(m.method ?? '')
        const own = method.startsWith(host.plugin + '.')
        if (!own && !host.grants().includes('core:' + method)) {
          reply(m.id, { error: t('{method} is not granted to {name}', { method, name: host.name }) })
          return
        }
        request(method, m.params).then(
          (result) => reply(m.id, { result }),
          (err) => {
            // A coded error (a password to ask) keeps its code for the frame; never "error", the default.
            const e = err as { message?: string; code?: string; data?: Record<string, string> }
            const coded = e.code && e.code !== 'error' ? { code: e.code, data: e.data ?? {} } : {}
            reply(m.id, { error: err instanceof Error ? err.message : String(e.message ?? err), ...coded })
          },
        )
        return
      }
      case 'on': {
        const event = String(m.event ?? '')
        if (event.startsWith(host.plugin + '.')) offs.push(on(event, (data: unknown) => port.postMessage({ event, data } satisfies PageMessage)))
        return
      }
      case 'openFile':
        if (typeof m.path === 'string') void openFile(typeof m.line === 'number' ? { path: m.path, line: m.line } : m.path)
        return
      case 'openView':
        if (typeof m.view === 'string')
          openTab({ kind: `plugin:${host.plugin}/${m.view}`, title: typeof m.title === 'string' ? m.title : undefined, state: m.state, key: typeof m.key === 'string' ? m.key.slice(0, 200) : undefined } as Omit<TabState, 'id'>)
        return
      case 'setViewState': {
        const tab = host.tab
        if (tab)
          mutate((s) => {
            const cur = s.tabs[tab.id]
            if (!cur?.kind.startsWith(`plugin:${host.plugin}/`)) return
            // The text of the tab's editor is the core's: kept under $text.
            const text = (cur.state as { $text?: string } | undefined)?.$text
            cur.state = text !== undefined && m.state && typeof m.state === 'object' && !Array.isArray(m.state) ? { ...(m.state as object), $text: text } : m.state
          })
        return
      }
      case 'toast':
        toast(String(m.text ?? '').slice(0, 500), m.kind && ['info', 'warn', 'error', 'ok'].includes(m.kind) ? m.kind : 'info')
        return
      case 'showConsole':
        // Only a console the IDE lists (the frame cannot make one up), once console.created came.
        if (typeof m.id === 'string') {
          const id = m.id
          const until = Date.now() + 3000
          const tryShow = () => {
            const term = capability('terminal')
            if (term?.consoles().some((c) => c.id === id)) term.show(id)
            else if (Date.now() < until) setTimeout(tryShow, 100)
          }
          tryShow()
        }
        return
      case 'copyText':
        // Only while the user is in the frame, as the keys: a plugin cannot fill the clipboard on its own.
        if (document.activeElement === frame && typeof m.text === 'string') void copyText(m.text.slice(0, maxEditorText))
        return
      case 'key':
        // Only while the user is in the frame: a plugin cannot press the IDE's keys on its own.
        if (document.activeElement !== frame) return
        frame.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, code: m.code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta, bubbles: true, cancelable: true }))
        return
      case 'focus':
        frame.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        return
      case 'ready':
        host.onReady?.()
        return
      case 'editorSet':
        if (typeof m.text === 'string' && m.text.length <= maxEditorText) host.editor?.setText(m.text)
        return
      case 'editorInsert':
        if (typeof m.text === 'string' && m.text.length <= maxEditorText) host.editor?.insert(m.text)
        return
      case 'editorMark':
        if (m.range === null) host.editor?.mark(null)
        else if (Array.isArray(m.range) && m.range.length === 2 && m.range.every((n) => Number.isInteger(n) && n >= 0)) host.editor?.mark([m.range[0], m.range[1]])
        return
      case 'editorFocus':
        host.editor?.focus()
        return
      case 'editorWords':
        if (Array.isArray(m.words)) host.editor?.setWords(m.words.filter((w) => typeof w === 'string' && w.length <= 200).slice(0, 20000))
        return
      default:
        // Every call of the API is answered above: tsc says when one is not.
        m satisfies never
    }
  }
  const send = (m: PageMessage) => port?.postMessage(m)
  // The theme, and the room of the buttons over its corner (headInset), last sent.
  let inset = ''
  const theme = (): SandboxTheme => {
    inset = headInset(frame)
    return { ...themeVars(), '--ide-head-inset': inset }
  }
  const editorState = () => {
    const st = host.editor?.state()
    return st && st.text.length <= maxEditorText ? st : st ? { ...st, text: st.text.slice(0, maxEditorText) } : undefined
  }
  const unsubscribe = () => {
    offs.forEach((f) => f())
    offs = []
  }
  const start = () => {
    unsubscribe()
    port?.close()
    const ch = new MessageChannel()
    port = ch.port1
    port.onmessage = handle(port)
    frame.contentWindow?.postMessage('ide', '*', [ch.port2])
    // The state of the tab is a proxy of the store: a plain copy crosses the channel.
    const state = host.tab?.state === undefined ? undefined : JSON.parse(JSON.stringify(host.tab.state))
    send({ init: { view: { id: host.view, state }, lang: lang(), catalog: catalog(), theme: theme(), editor: editorState(), settings: host.settings?.() } })
  }
  frame.addEventListener('load', start)
  // The theme and the language follow the page.
  const observer = new MutationObserver(() => send({ theme: theme() }))
  // The buttons over its corner move with its size (a tile, a zone, a detached window).
  const resized = new ResizeObserver(() => {
    const now = headInset(frame)
    if (now !== inset && port) send({ theme: theme() })
  })
  resized.observe(frame)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  return {
    send,
    lang: () => send({ lang: lang(), catalog: catalog() }),
    /** The editor's text or selection changed; a key of the editor was pressed. */
    editorChanged: () => {
      const st = editorState()
      if (st) send({ editor: st })
    },
    editorKey: (name: string) => send({ editorKey: name }),
    /** Its settings changed. */
    settings: () => host.settings && send({ settings: host.settings() }),
    stop: () => {
      frame.removeEventListener('load', start)
      observer.disconnect()
      resized.disconnect()
      unsubscribe()
      port?.close()
    },
  }
}
