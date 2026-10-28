// The grammars of the language packs installed on the pod (#145): a layer of languages.ts between
// the built-in grammars and the user's rules. Asked when the plugins change, and awaited before a
// session restored loads its documents: a .go read before its pack is known is detected as plain
// text, and stays colorless until the tab is closed and opened again.
import { request } from '../pod/rpc'
import { setPackGrammars } from './languages'
import type { GrammarDef } from './tokenizer'

let asked: Promise<void> | undefined

/** Asks the pod for the grammars of the installed packs (one ask at a time). */
export function refreshPackGrammars() {
  asked ??= request<{ pack: string; grammar: GrammarDef }[]>('plugins.grammars')
    .then((list) => setPackGrammars(list.map((g) => g.grammar)))
    .catch(() => {})
    .finally(() => (asked = undefined))
  return asked
}

/** The last ask, when one is still running (the grammars of a settled one are already in). */
export function packGrammarsReady() {
  return asked ?? Promise.resolve()
}
