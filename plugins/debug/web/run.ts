// Run › Debug…: picks a configuration of .ide/debug.json and starts it. A file without any offers
// the templates of the language packs the project uses: the one chosen is written into the file,
// then started. Edit configurations… opens the file in a tab.
import { api, errorToast, t } from './plugin'
import { start } from './state'
import { askNotifications } from './focus'

interface Template {
  label: string
  pack: string
  packName?: string
  type: string
  request: string
  config: Record<string, unknown>
}
interface Configurations {
  configurations: { name: string; type: string; request: string }[] | null
  templates: Template[] | null
  file: string
}

type Choice = { kind: 'config'; name: string } | { kind: 'template'; tp: Template } | { kind: 'edit' }

export async function runDebug() {
  let c: Configurations
  try {
    c = await api.rpc<Configurations>('configurations')
  } catch (e) {
    return errorToast(e)
  }
  const configs = c.configurations ?? []
  const templates = c.templates ?? []
  const items: { label: string; detail?: string; icon?: string; value: Choice }[] = configs.length
    ? configs.map((x) => ({ label: x.name, detail: `${x.type} · ${x.request}`, icon: 'bug', value: { kind: 'config', name: x.name } as Choice }))
    : templates.map((tp) => ({ label: tp.label, detail: t('Template of {pack}', { pack: tp.packName || tp.pack }), icon: 'plus', value: { kind: 'template', tp } as Choice }))
  if (!items.length) return api.ui.toast(t('No language pack of this project gives a debugger.'), 'info')
  items.push({ label: t('Edit configurations…'), icon: 'edit', value: { kind: 'edit' } })
  const chosen = await api.ui.pick<Choice>({ placeholder: configs.length ? t('Debug a configuration') : t('No configuration yet: start from a template'), items })
  if (!chosen) return
  if (chosen.kind === 'edit') return editConfigurations(c.file)
  askNotifications()
  if (chosen.kind === 'config') return void start({ name: chosen.name })
  try {
    const saved = await api.rpc<{ name: string }>('addConfiguration', { config: chosen.tp.config })
    void start({ name: saved.name })
  } catch (e) {
    errorToast(e)
  }
}

/** Opens .ide/debug.json in a tab (the configurations as text). */
export async function editConfigurations(file?: string) {
  try {
    const path = file ?? (await api.rpc<Configurations>('configurations')).file
    void api.openFile(path)
  } catch (e) {
    errorToast(e)
  }
}
