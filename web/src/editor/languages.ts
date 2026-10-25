// Language registry: built-in grammars, overridden by the rules edited in the settings.
import { createSignal } from 'solid-js'
import { builtinGrammars } from './grammars'
import { Grammar, type GrammarDef } from './tokenizer'
import { t } from '../i18n'

const [overrides, setOverridesSignal] = createSignal<Record<string, GrammarDef>>({})
const [generation, setGeneration] = createSignal(0)
/** Changes each time a grammar changes: views re-highlight. */
export const grammarGeneration = generation

const cache = new Map<string, Grammar>()

export function setGrammarOverrides(o: Record<string, GrammarDef> | undefined) {
  const next = o ?? {}
  if (JSON.stringify(next) === JSON.stringify(overrides())) return
  setOverridesSignal(next)
  cache.clear()
  setGeneration((g) => g + 1)
}

// The grammars of the language packs installed (#145): over the built-ins, under the user's.
const [packGrammars, setPackGrammarsSignal] = createSignal<GrammarDef[]>([])

export function setPackGrammars(list: GrammarDef[]) {
  if (JSON.stringify(list) === JSON.stringify(packGrammars())) return
  setPackGrammarsSignal(list)
  cache.clear()
  setGeneration((g) => g + 1)
}

export function grammarDefs(): GrammarDef[] {
  const o = overrides()
  const packs = packGrammars()
  const base = [...builtinGrammars.filter((g) => !packs.some((p) => p.id === g.id)), ...packs]
  const ids = new Set(base.map((g) => g.id))
  return [...base.map((g) => o[g.id] ?? g), ...Object.values(o).filter((g) => !ids.has(g.id))]
}

/** The grammar of a language before the user's changes: a pack's, else the core's. */
export function builtinGrammar(id: string) {
  return packGrammars().find((g) => g.id === id) ?? builtinGrammars.find((g) => g.id === id)
}

export function grammar(id: string): Grammar {
  let g = cache.get(id)
  if (!g) {
    const def = grammarDefs().find((d) => d.id === id) ?? builtinGrammars.find((d) => d.id === 'plaintext')!
    g = new Grammar(def)
    cache.set(id, g)
  }
  return g
}

export function languageName(id: string) {
  // Language names are proper nouns, except plain text.
  if (id === 'plaintext') return t('Text')
  return grammarDefs().find((d) => d.id === id)?.name ?? id
}

function basename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Detects the language from the extension first, then from the content. */
export function detectLanguage(path: string, content = ''): string {
  const defs = grammarDefs()
  const name = basename(path)
  for (const d of defs) if (d.filenames?.includes(name)) return d.id
  const lower = name.toLowerCase()
  if (lower.endsWith('.conf') && /nginx|sites-(?:available|enabled)|conf\.d/.test(path)) return 'nginx'
  let best = ''
  let bestId = ''
  for (const d of defs) {
    for (const ext of d.extensions) {
      if (lower.endsWith(ext) && ext.length > best.length) {
        best = ext
        bestId = d.id
      }
    }
  }
  // .conf files are only nginx when the content looks like it.
  if (bestId && !(bestId === 'nginx' && !/\b(?:server|location|http|upstream|events)\b/.test(content.slice(0, 4000)))) return bestId
  const head = content.slice(0, 2000)
  for (const d of defs) {
    if (d.detect) {
      try {
        if (new RegExp(d.detect, 'm').test(head)) return d.id
      } catch {
        /* invalid user regex */
      }
    }
  }
  return 'plaintext'
}

/** Server language (LSP) handling a file. */
// The languages of the language packs the project uses (#145): their servers are the host's.
let packLanguages: { id: string; extensions: string[]; languageIds?: Record<string, string> }[] = []

export function setPackLanguages(list: typeof packLanguages) {
  packLanguages = list
}

const packOf = (ext: string) => packLanguages.find((l) => l.extensions.includes(ext))

export function lspLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  const pack = packOf(ext)
  return pack?.id ?? ''
}

/** LSP languageId of a file. */
export function lspLanguageId(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  const pack = packOf(ext)
  if (pack) return pack.languageIds?.[ext] ?? pack.id
  return 'plaintext'
}
