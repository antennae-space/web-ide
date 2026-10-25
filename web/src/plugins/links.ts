// The links of the plugins (contributes.links, #155): a parameter of a project's address opens a
// tab view of the plugin that declares it, /project/<id>?ticket=12 the ticket view of the Kanban.
import { openTab, type TabState } from '../state/project'
import { pluginStates } from './registry'

/** Opens the views the parameters of search name, for the enabled plugins; true when one did. */
export function openLinks(search: URLSearchParams): boolean {
  let opened = false
  for (const s of pluginStates()) {
    if (!s.enabled) continue
    for (const l of s.manifest.contributes.links ?? []) {
      const raw = search.get(l.param)
      if (!raw) continue
      const value = l.type === 'number' ? Number(raw) : raw
      if (l.type === 'number' && !(Number(value) > 0)) continue
      openTab({ kind: `plugin:${s.manifest.id}/${l.view}`, key: raw, state: { [l.param]: value } } as Omit<TabState, 'id'>)
      opened = true
    }
  }
  return opened
}
