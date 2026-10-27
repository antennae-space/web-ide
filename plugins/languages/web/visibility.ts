// Exported or private: the rules of web/visibility.json, one table read by this module and by
// the pod (plugins/languages/visibility.go embeds the same file). The Structure tool shows an
// open lock for an exported symbol, a closed one for a private symbol, and nothing when the
// language has no rule.
import visibilityJson from './visibility.json'

export type Visibility = 'exported' | 'private' | 'none'

interface Rule {
  field: 'name' | 'detail'
  match: string
  visibility: Visibility
}
interface LanguageRules {
  default: Visibility
  rules?: Rule[]
}

const table = visibilityJson as { default: Visibility; languages: Record<string, LanguageRules> }

/** The receiver prefix a server puts in front of a method name: gopls names a method (Greeter).Hello. */
const memberNameRe = /^\([^)]*\)\./

/** Name of a symbol without its receiver prefix. */
export function memberName(name: string): string {
  return name.replace(memberNameRe, '')
}

/**
 * Visibility of a symbol of a language pack (its id: go, typescript, python…): the first rule
 * that matches its name or its detail decides, else the default of the language, else the
 * default of the table (none: no badge).
 */
export function visibilityOf(lang: string, s: { name: string; detail?: string }): Visibility {
  const rules = table.languages[lang]
  if (!rules) return table.default
  for (const r of rules.rules ?? []) {
    const field = r.field === 'name' ? memberName(s.name) : (s.detail ?? '')
    if (field && new RegExp(r.match).test(field)) return r.visibility
  }
  return rules.default
}
