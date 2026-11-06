// Aliases (#229): short texts of the user, in the / list of the message boxes of the assistant
// and of the agents. A choice inserts the text. The list is global: it is kept in the synced
// settings, and until the first edit the presets show.
import { storedSetting, storeSetting, t } from '../plugin'
import type { CompletionItem } from './MessageBox'

export interface Alias {
  name: string
  text: string
  /** The text is a preset's, an English key of the catalogs, until the user edits it. */
  preset?: boolean
}

const presets: Alias[] = [
  { name: 'scr', text: 'Simplify, compress, and repeat your response', preset: true },
  { name: 'ref', text: 'Rewrite your responses with reference points', preset: true },
  { name: 'q', text: 'Remarks / Questions / Idea / Proposal?', preset: true },
]

export function aliases(): Alias[] {
  const list = storedSetting('aliases')
  return Array.isArray(list) ? (list as Alias[]) : presets
}

/** Saves plain copies: a list read from the settings holds proxies of their store. */
export const saveAliases = (list: Alias[]) => storeSetting('aliases', list.map((a) => ({ ...a })), 'Aliases')

/** The text of an alias in the language of the page. */
export const aliasText = (a: Alias) => (a.preset ? t(a.text) : a.text)

/** A name as the / list reads it: one word, no leading slash. */
export const aliasName = (s: string) => s.replace(/\s+/g, '').replace(/^\/+/, '')

/**
 * The items of the / list. A command comes first: an alias with the name of an item of `taken`
 * does not show, and of two aliases of the same name, only the first. An alias acts by a choice
 * in the list only: what is sent for a typed /name does not depend on the aliases.
 */
export function aliasItems(taken: CompletionItem[]): CompletionItem[] {
  const seen = new Set(taken.map((it) => it.label))
  const out: CompletionItem[] = []
  for (const a of aliases()) {
    const label = `/${a.name}`
    const text = aliasText(a)
    if (!a.name || !text.trim() || seen.has(label)) continue
    seen.add(label)
    out.push({ kind: 'alias', label, detail: text, insert: text })
  }
  return out
}
