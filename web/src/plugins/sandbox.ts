// The sandbox API of an external plugin (docs/design/plugins.md, *Sandboxed views*): its views
// run in an <iframe sandbox="allow-scripts"> (an opaque origin) whose CSP forbids the network;
// one MessageChannel per frame carries what they may ask. The page is the boundary: a method of
// the core needs its grant, an event must be of the plugin's namespace.
import { on, request } from '../pod/rpc'
import { openFile, openTab, mutate, type TabState } from '../state/project'
import { toast } from '../ui/toast'
import { confirmModal, pick, prompt } from '../ui/overlay'
import { copyText } from '../ui/clipboard'
import { capability } from './capabilities'
import { emit, openModalOf, publish, use } from './services'
import { lang, t } from '../i18n'
import type { FrameCall, PageMessage, SandboxEditorState, SandboxModalSize, SandboxTheme } from './sandbox-api'

/** The CSP of a frame: inline scripts and styles, images as data, no network at all. */
export const frameCSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'"

/**
 * The bootstrap run in the frame before the plugin's module: `ide`, the API the module calls
 * (register, rpc, on, openFile, openView, setViewState, t, tn, toast, theme, editor, settings, use, publish, emit), over the port the
 * page sends once. Plain ES2020, no import.
 */
export const bootstrap = `(() => {
  let port, info = null, registered = false, mounted = false
  let views = {}, commands = {}, services = {}
  // The capabilities of other plugins it uses: their values pushed by the page, its listeners.
  const used = {}
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
    register(c) { views = (c && c.views) || {}; commands = (c && c.commands) || {}; services = (c && c.services) || {}; registered = true; start() },
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
    confirm: (o) => call({ call: 'dialog', confirm: plain(o) }),
    prompt: (o) => call({ call: 'dialog', prompt: plain(o) }),
    pick: (o) => call({ call: 'dialog', pick: plain(o) }),
    openModal: (view, state, o) => call({ call: 'openModal', view, state: plain(state), title: o && o.title, size: o && o.size, plugin: o && o.plugin }),
    use(capability) {
      let u = used[capability]
      if (!u) {
        u = used[capability] = { values: {}, valueFns: {}, eventFns: {} }
        send({ call: 'serviceWatch', capability })
      }
      return {
        call: (method, ...args) => call({ call: 'serviceCall', capability, method, args: plain(args) }),
        value: (key) => u.values[key],
        onValue: (key, f) => (u.valueFns[key] = u.valueFns[key] || []).push(f),
        on: (event, f) => (u.eventFns[event] = u.eventFns[event] || []).push(f),
      }
    },
    publish: (capability, key, value) => send({ call: 'publish', capability, key, value: plain(value) }),
    emit: (capability, event, data) => send({ call: 'serviceEmit', capability, event, data: plain(data) }),
    closeModal: (result) => send({ call: 'closeModal', result: plain(result) }),
    get modal() { return !!(info && info.modal) },
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
    // A method of a capability it provides, asked by the page for another plugin.
    if (m.serviceRequest) {
      const id = m.serviceRequest, f = services[m.capability] && services[m.capability][m.method]
      Promise.resolve()
        .then(() => { if (typeof f !== 'function') throw new Error('no method ' + m.method + ' of ' + m.capability); return f(...(m.args || [])) })
        .then((result) => send({ call: 'serviceReply', id, result: plain(result) }), (e) => send({ call: 'serviceReply', id, error: String((e && e.message) || e) }))
    }
    const setValue = (u, key, value) => { u.values[key] = value; (u.valueFns[key] || []).forEach((f) => f(value)) }
    if (m.serviceValues && used[m.serviceValues.capability]) for (const [k, v] of Object.entries(m.serviceValues.values)) setValue(used[m.serviceValues.capability], k, v)
    if (m.serviceValue && used[m.serviceValue.capability]) setValue(used[m.serviceValue.capability], m.serviceValue.key, m.serviceValue.value)
    if (m.serviceEvent && used[m.serviceEvent.capability]) ((used[m.serviceEvent.capability].eventFns[m.serviceEvent.event]) || []).forEach((f) => f(m.serviceEvent.data))
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
  /** The capabilities of its manifest: those it may use (ide.use), those it serves. */
  requires?: string[]
  provides?: string[]
  /** Its grants now: a grant revoked in Settings is refused at once. */
  grants: () => string[]
  catalogs: Record<string, Record<string, string>>
  /** The view of the frame ("" for the hidden one of the commands) and its tab (a tab view). */
  view: string
  tab?: TabState
  /** The state of a modal view, given by its opener. */
  state?: unknown
  onReady?: () => void
  /** The editor of the tab (a tab view whose manifest asks it). */
  editor?: FrameEditor
  /** Its settings now (the defaults where the user set nothing). */
  settings?: () => Record<string, unknown>
  /** Opens one of its modal views in a modal of the core: the result its view closes it with. */
  openModal?: (view: string, state: unknown, title: string, size: SandboxModalSize) => Promise<unknown>
  /** A modal view: closes its modal with a result. */
  closeModal?: (result: unknown) => void
}

/**
 * Whether the user is in the view of a frame: the frame has the focus, or the core's editor of
 * its tab (a key of the manifest pressed there, Ctrl+Enter of a console).
 */
const userIn = (frame: HTMLIFrameElement) => {
  const a = document.activeElement
  return a === frame || !!(a && frame.closest('.plugin-editor-tab')?.contains(a))
}

/**
 * userIn, a moment allowed: the focus goes to a frame of another process asynchronously, so its
 * message may come before the page sees the click that sent it.
 */
async function userInSoon(frame: HTMLIFrameElement) {
  for (let i = 0; i < 10; i++) {
    if (userIn(frame)) return true
    await new Promise((r) => setTimeout(r, 30))
  }
  return false
}

/** A text of a dialog, as plain text of a bounded length. */
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '')

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
  // What the page asked the frame for another plugin (a method of a capability it serves).
  const asked = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextAsk = 1
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
      case 'dialog':
        void (async () => {
          // The dialogs of the core, while the user is in the view, titled with the plugin.
          if (!(await userInSoon(frame))) return reply(m.id, { error: t('A dialog opens only while you use the plugin') })
          const title = `${host.name} · ${clip(m.confirm?.title ?? m.prompt?.title ?? m.pick?.title, 200)}`
          if (m.confirm) {
            void confirmModal({ title, text: clip(m.confirm.text, 2000), ok: clip(m.confirm.ok, 60) || undefined, danger: !!m.confirm.danger }).then((result) => reply(m.id, { result }))
          } else if (m.prompt) {
            const p = m.prompt
            void prompt({ title, label: clip(p.label, 2000) || undefined, value: clip(p.value, 10000), password: !!p.password, placeholder: clip(p.placeholder, 200) || undefined }).then((result) => reply(m.id, { result }))
          } else if (m.pick && Array.isArray(m.pick.items)) {
            const items = m.pick.items.slice(0, 500).map((it, i) => ({ label: clip(it?.label, 300), detail: clip(it?.detail, 300) || undefined, value: i }))
            void pick<number>({ placeholder: title, items, initial: Number.isInteger(m.pick.initial) ? m.pick.initial : 0 }).then((result) => reply(m.id, { result: result ?? null }))
          } else reply(m.id, { error: 'dialog: confirm, prompt or pick' })
        })()
        return
      case 'openModal':
        void (async () => {
          if (!(await userInSoon(frame))) return reply(m.id, { error: t('A dialog opens only while you use the plugin') })
          const size: SandboxModalSize = m.size === 'small' || m.size === 'large' ? m.size : 'medium'
          // A modal view of another plugin: one providing a capability this one requires.
          const other = typeof m.plugin === 'string' && m.plugin !== host.plugin ? m.plugin : ''
          if ((!other && !host.openModal) || typeof m.view !== 'string') return reply(m.id, { error: t('{name} has no such modal view', { name: host.name }) })
          const opened = other ? openModalOf(host.requires ?? [], other, m.view, m.state, clip(m.title, 200), size) : host.openModal!(m.view, m.state, clip(m.title, 200), size)
          opened.then(
            (result) => reply(m.id, { result: result ?? null }),
            (err) => reply(m.id, { error: err instanceof Error ? err.message : String(err) }),
          )
        })()
        return
      case 'closeModal':
        host.closeModal?.(m.result)
        return
      case 'serviceCall': {
        const svc = use({ name: host.name, requires: host.requires ?? [] }, String(m.capability ?? ''))
        if (typeof svc === 'string') return reply(m.id, { error: svc })
        svc.call(String(m.method ?? ''), Array.isArray(m.args) ? m.args : []).then(
          (result) => reply(m.id, { result }),
          (err) => reply(m.id, { error: err instanceof Error ? err.message : String(err) }),
        )
        return
      }
      case 'serviceWatch': {
        const capability = String(m.capability ?? '')
        const svc = use({ name: host.name, requires: host.requires ?? [] }, capability)
        if (typeof svc === 'string') return
        port.postMessage({ serviceValues: { capability, values: JSON.parse(JSON.stringify(svc.values())) } } satisfies PageMessage)
        offs.push(svc.onValue((key, value) => port.postMessage({ serviceValue: { capability, key, value } } satisfies PageMessage)))
        offs.push(svc.on((event, data) => port.postMessage({ serviceEvent: { capability, event, data } } satisfies PageMessage)))
        return
      }
      case 'serviceReply': {
        const a = asked.get(m.id)
        asked.delete(m.id)
        if (a) 'error' in m && m.error !== undefined ? a.reject(new Error(String(m.error))) : a.resolve(m.result)
        return
      }
      case 'publish':
        if (host.provides?.includes(m.capability) && typeof m.key === 'string') publish(host.plugin, m.capability, m.key.slice(0, 200), m.value)
        return
      case 'serviceEmit':
        if (host.provides?.includes(m.capability) && typeof m.event === 'string') emit(host.plugin, m.capability, m.event.slice(0, 200), m.data)
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
    const st = host.tab ? host.tab.state : host.state
    const state = st === undefined ? undefined : JSON.parse(JSON.stringify(st))
    send({ init: { view: { id: host.view, state }, lang: lang(), catalog: catalog(), theme: theme(), editor: editorState(), settings: host.settings?.(), modal: !!host.closeModal } })
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
    /** Asks the frame a method of a capability it serves, for another plugin. */
    request: (capability: string, method: string, args: unknown[]) =>
      new Promise<unknown>((resolve, reject) => {
        if (!port) return reject(new Error(t('{name} is not ready', { name: host.name })))
        const id = nextAsk++
        asked.set(id, { resolve, reject })
        send({ serviceRequest: id, capability, method, args: JSON.parse(JSON.stringify(args)) })
      }),
    stop: () => {
      asked.forEach((a) => a.reject(new Error(t('{name} is not ready', { name: host.name }))))
      asked.clear()
      frame.removeEventListener('load', start)
      observer.disconnect()
      resized.disconnect()
      unsubscribe()
      port?.close()
    },
  }
}
