// The servers of the language packs the project uses (#153): found or missing, and how the IDE
// installs a missing one (a console of the core runs the pack's recipe into its folder of
// tools). The editor shows a banner for a file whose language has no server; a language the
// user put off ("Not now") keeps it hidden, per pod.
import { createSignal } from 'solid-js'
import type { PackServer } from '@ide/capabilities'
import { api, t, toast } from './plugin'
import { resync } from './sync'

const [servers, setServers] = createSignal<PackServer[]>([])
export { servers }

const dismissKey = 'ide.languageServers.notNow'
function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(dismissKey) ?? '[]')
  } catch {
    return []
  }
}
const [dismissed, setDismissed] = createSignal<string[]>(readDismissed())

export async function refreshServers() {
  try {
    setServers(await api.rpc<PackServer[]>('lsp.servers'))
  } catch {
    /* no project: none */
  }
}

/** The consoles installing a server: when one ends, the servers are looked for again and the
 * open buffers announced again (their didOpen went nowhere before). */
const installing = new Set<string>()

export function watchPackServers() {
  void refreshServers()
  api.on('plugins.changed', () => void refreshServers())
  api.on('console.exit', (e: { id: string }) => {
    if (installing.delete(e.id)) void refreshServers().then(resync)
  })
}

/** The server to offer for a file: its language has a pack, none of its servers is found. */
export function missingServer(path: string): PackServer | null {
  const lang = api.editor.serverLanguage(path)
  if (!lang) return null
  const list = servers().filter((s) => s.lang === lang)
  if (!list.length || list.some((s) => s.path)) return null
  return list.find((s) => s.install && !s.needs) ?? list.find((s) => s.install) ?? list[0]
}

/** Whether the banner of a language was put off ("Not now"). */
export const notNow = (lang: string) => dismissed().includes(lang)

export function putOff(lang: string) {
  const next = [...new Set([...dismissed(), lang])]
  setDismissed(next)
  try {
    localStorage.setItem(dismissKey, JSON.stringify(next))
  } catch {
    /* kept for this page only */
  }
}

/** Runs the recipe of a server in a console of the core, shown. */
export async function installServer(s: PackServer) {
  try {
    const r = await api.rpc<{ console: string }>('lsp.install', { pack: s.pack, program: s.program })
    installing.add(r.console)
    api.use('terminal')?.show(r.console)
    toast(t('Installing {program}: its console shows the progress', { program: s.program }), 'info')
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}
