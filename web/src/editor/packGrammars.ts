// The grammars of the language packs installed on the pod (#145): a layer of languages.ts between
// the built-in grammars and the user's rules. Asked when the plugins change; the opening starts the
// ask in the background and does not wait for it. A buffer read before its pack is known is detected
// as plain text until the grammars arrive, then detected again (onGrammarsChanged of project.ts).
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
