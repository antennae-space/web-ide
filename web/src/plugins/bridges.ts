// The bridges of the core (docs/design/plugins.md, *Bridges*, #167): a reviewed part of a
// capability a built-in provides, offered to the frames of the external plugins requiring it,
// on the grant use:<capability>. What a frame may ask goes through the checks here, never to
// the built-in's service as it is: a console runs a command as the user, a conversation of the
// assistant acts in the project.
import { createEffect, createRoot, on } from 'solid-js'
import { t } from '../i18n'
import { mutate, root } from '../state/project'
import { showTool } from '../state/zones'
import { capability, type Capabilities } from './capabilities'
import type { ExternalService } from './services'

const str = (v: unknown, n = 2000) => (typeof v === 'string' ? v.slice(0, n) : undefined)
const bad = (what: string) => Promise.reject(new Error(t('invalid argument: {what}', { what })))

/** A folder of the project of the window, relative or absolute ("" its root). */
function projectDir(v: unknown): string | undefined {
  const d = str(v, 4000) ?? ''
  const r = root()
  if (!d) return r
  const abs = d.startsWith('/') ? d : `${r}/${d}`
  const parts: string[] = []
  for (const p of abs.split('/')) {
    if (p === '..') parts.pop()
    else if (p && p !== '.') parts.push(p)
  }
  const clean = '/' + parts.join('/')
  return clean === r || clean.startsWith(r + '/') ? clean : undefined
}

type Methods = Record<string, (args: unknown[]) => Promise<unknown>>
type Bridge<K extends keyof Capabilities> = {
  methods: (c: Capabilities[K]) => Methods
  /** The values a frame follows, read from the service (reactive). */
  values?: (c: Capabilities[K]) => Record<string, unknown>
}

const bridges: { [K in keyof Capabilities]?: Bridge<K> } = {
  assistant: {
    methods: (a) => ({
      newChat: async ([o]) => {
        const x = (o ?? {}) as Record<string, unknown>
        const tk = x.ticket as Record<string, unknown> | undefined
        const mode = ['briefing', 'plan', 'build'].includes(String(x.mode)) ? String(x.mode) : 'build'
        a.newChat({
          mode,
          title: str(x.title, 200),
          adoptedBy: str(x.adoptedBy, 200),
          ticket: tk && Number.isInteger(tk.id) ? { id: tk.id, role: str(tk.role, 40), feedback: Number.isInteger(tk.feedback) ? tk.feedback : undefined, effort: str(tk.effort, 20) } : undefined,
        })
      },
      send: ([text]) => (typeof text === 'string' ? a.send(text.slice(0, 100000)) : bad('text')),
      openChat: ([id]) => (typeof id === 'string' ? a.openChat(id.slice(0, 200)) : bad('id')),
      loadConfig: () => a.loadConfig(),
      // The Assistant tool shown.
      show: async () => mutate((s) => showTool(s, 'assistant')),
    }),
    values: (a) => ({ chat: a.chat(), config: a.config() }),
  },
  agents: {
    methods: (g) => ({
      // A session shown in the Agents tool, the tool shown.
      show: async ([session]) => {
        if (typeof session !== 'string') return bad('session')
        mutate((s) => showTool(s, 'agents'))
        g.show(session.slice(0, 200))
      },
      catalog: ([project]) => g.catalog(str(project, 200)),
    }),
  },
  commands: {
    methods: (c) => ({
      load: () => c.load(),
      // The editor of the saved commands (a modal of the IDE), on one of them or a draft.
      edit: async ([o]) => {
        const x = (o ?? {}) as { select?: unknown; draft?: Record<string, unknown> }
        c.edit({ select: str(x.select, 200), draft: x.draft ? { name: str(x.draft.name, 200), command: str(x.draft.command, 4000), flag: ['serve', 'build', 'test', 'lint', 'setup', 'other'].includes(String(x.draft.flag)) ? (x.draft.flag as never) : undefined } : undefined })
      },
    }),
    values: (c) => ({ list: c.list() }),
  },
  terminal: {
    methods: (term) => ({
      open: async ([o]) => {
        const x = (o ?? {}) as Record<string, unknown>
        const cwd = projectDir(x.cwd)
        if (cwd === undefined) return bad('cwd')
        const command = x.command
        if (command !== undefined && (!Array.isArray(command) || !command.every((c) => typeof c === 'string') || command.length > 200)) return bad('command')
        const c = await term.open({ cwd, command: command as string[] | undefined, title: str(x.title, 200), kind: x.kind === 'task' ? 'task' : 'terminal' })
        return c?.id ?? null
      },
      show: async ([id]) => (typeof id === 'string' ? term.show(id) : bad('id')),
    }),
  },
}

/**
 * The bridge of a capability a built-in provides, as a service of a frame: undefined when there
 * is none, or no built-in provides it now.
 */
export function bridgeFor(name: string): ExternalService | undefined {
  const b = bridges[name as keyof Capabilities] as Bridge<keyof Capabilities> | undefined
  if (!b || !capability(name as keyof Capabilities)) return undefined
  return (made[name] ??= make(name, b))
}

// The bridges made, once each: the service is read when asked, so one stays good.
const made: Record<string, ExternalService> = {}

function make(name: string, b: Bridge<keyof Capabilities>): ExternalService {
  const impl = () => capability(name as keyof Capabilities)
  const watchers = new Set<(key: string, value: unknown) => void>()
  const values = () => {
    const c = impl()
    return c && b.values ? JSON.parse(JSON.stringify(b.values(c as never))) : {}
  }
  if (b.values)
    createRoot(() =>
      createEffect(
        on(values, (v: Record<string, unknown>) => {
          for (const [k, x] of Object.entries(v)) watchers.forEach((f) => f(k, x))
        }),
      ),
    )
  return {
    provider: 'core',
    call: (method, args) => {
      const c = impl()
      const f = c && b.methods(c as never)[method]
      return f ? f(args) : Promise.reject(new Error(t('{method} is not a method of the bridge of {name}', { method, name })))
    },
    value: (key) => values()[key],
    values,
    on: () => () => {},
    onValue: (f) => (watchers.add(f), () => watchers.delete(f)),
  }
}
