// Grammar engine. A grammar is data: for each state, an ordered list of {token, regex}
// rules; at the current position the first matching rule wins. Rules can push a state
// (multi-line comments, strings, embedded code) or pop back with "@pop". A rule `embed` hands
// the rest of its state to another grammar (the CSS of <style>, the JavaScript of <script>):
// the rules of the state before it end the embedded code, whatever state that code is in.
// Adding a language never touches the engine.

export interface RuleDef {
  token: string
  regex: string
  flags?: string
  next?: string // state to push, or "@pop"
  include?: string // inline the rules of another state
  /**
   * The id of a language whose grammar takes the rest of the state (token and regex unused).
   * Its states are pushed as `<id>><state>`; the rules of this state placed before this one are
   * tried first at each position and end it (`(?=</script\b)` → `@pop`).
   */
  embed?: string
}

export interface GrammarDef {
  id: string
  name: string
  extensions: string[]
  filenames?: string[]
  /** Regex tested on the first lines when the extension says nothing. */
  detect?: string
  states: Record<string, RuleDef[]>
}

interface Rule {
  token: string
  re: RegExp
  /** The same regex, not sticky: where it matches next (the end of embedded code). */
  scan: RegExp
  next?: string
}

/** The rules of a state: those tried in order, and the language its content is handed to. */
interface State {
  rules: Rule[]
  embed?: string
}

/** Finds the grammar of another language (an embedded one). */
export type GrammarResolver = (id: string) => Grammar | undefined

const EMBED = '>'

export type Token = [start: number, end: number, type: string]

export class Grammar {
  states: Record<string, Rule[]> = {}
  /** The language each state hands its content to, after its own rules. */
  embeds: Record<string, string> = {}
  errors: string[] = []

  constructor(
    public def: GrammarDef,
    private resolve: GrammarResolver = () => undefined,
  ) {
    const expand = (name: string, seen: Set<string>): RuleDef[] => {
      const out: RuleDef[] = []
      for (const r of def.states[name] ?? []) {
        if (r.include) {
          if (!seen.has(r.include)) out.push(...expand(r.include, new Set([...seen, r.include])))
        } else out.push(r)
      }
      return out
    }
    for (const name of Object.keys(def.states)) {
      this.states[name] = []
      for (const r of expand(name, new Set([name]))) {
        if (r.embed) {
          // The rules after it would never be tried.
          this.embeds[name] = r.embed
          break
        }
        try {
          const flags = (r.flags ?? '').replace(/[gy]/g, '') + 'y'
          this.states[name].push({ token: r.token, re: new RegExp(r.regex, flags), scan: new RegExp(r.regex, flags.replace('y', 'g')), next: r.next })
        } catch (e) {
          this.errors.push(`${name}: /${r.regex}/ : ${(e as Error).message}`)
        }
      }
    }
    if (!this.states.root) this.states.root = []
  }

  /** The rules of a frame of the stack: one of this grammar's states, or `<id>><state>` of an embedded one. */
  private frame(seg: string): State {
    const k = seg.indexOf(EMBED)
    if (k < 0) return { rules: this.states[seg] ?? this.states.root, embed: this.embeds[seg] }
    const g = this.resolve(seg.slice(0, k))
    const name = seg.slice(k + 1)
    // An embedded grammar does not embed in turn (its frames would need their own host).
    return { rules: g ? (g.states[name] ?? g.states.root) : [] }
  }

  /** Tokenizes one line starting in the state stack `stack` ("root/comment"). */
  line(text: string, stack: string): { tokens: Token[]; end: string } {
    const st = stack.split('/')
    const tokens: Token[] = []
    let pos = 0
    const emit = (start: number, end: number, token: string) => {
      if (!token || token === 'text') return
      const last = tokens[tokens.length - 1]
      if (last && last[1] === start && last[2] === token) last[1] = end
      else tokens.push([start, end, token])
    }
    /**
     * Tries the rules at pos on `subject` (the line, or its part before the end of embedded code):
     * false when none matches. `base`: the frames of the stack a pop keeps.
     */
    const step = (rules: Rule[], prefix: string, base: number, subject = text): boolean => {
      for (const r of rules) {
        r.re.lastIndex = pos
        const m = r.re.exec(subject)
        if (!m) continue
        if (m[0].length === 0 && !r.next) continue
        emit(pos, pos + m[0].length, r.token)
        pos += m[0].length
        if (r.next === '@pop') {
          if (st.length > base) st.pop()
        } else if (r.next) st.push(prefix + r.next)
        return true
      }
      return false
    }
    let end: { host: number; from: number; at: number } | undefined
    while (pos < text.length) {
      const top = st[st.length - 1]
      let matched = false
      if (top.includes(EMBED)) {
        // In embedded code: the end rules of its host state first, which cut the embedded frames.
        let host = st.length - 1
        while (host > 0 && st[host].includes(EMBED)) host--
        const hostState = this.frame(st[host])
        // The embedded grammar sees the line up to the next end only: a string or a comment of
        // its own never runs past </script>.
        // No end before the one found (a minified line): kept until passed.
        if (!end || end.host !== host || pos < end.from || pos > end.at) {
          let at = text.length
          for (const r of hostState.rules) {
            r.scan.lastIndex = pos
            const m = r.scan.exec(text)
            if (m && m.index < at) at = m.index
          }
          end = { host, from: pos, at }
        }
        const limit = end.at
        if (limit === pos) {
          st.length = host + 1
          matched = step(hostState.rules, '', 1)
        } else {
          const id = top.slice(0, top.indexOf(EMBED) + 1)
          matched = step(this.frame(top).rules, id, host + 2, text.slice(0, limit))
        }
      } else {
        const state = this.frame(top)
        matched = step(state.rules, '', 1)
        if (!matched && state.embed) {
          // The rest of the state is the other language's: its root, without consuming.
          st.push(state.embed + EMBED + 'root')
          matched = true
        }
      }
      if (!matched) pos++
      if (st.length > 32) st.splice(1, st.length - 32)
    }
    return { tokens, end: st.join('/') }
  }
}

/**
 * Highlighter keeps, for each line, the state at its start and its tokens. Lines are
 * tokenized lazily up to the last line asked for; an edit only invalidates the lines
 * from the edited one.
 */
export class Highlighter {
  private starts: string[] = ['root']
  private tokens: (Token[] | undefined)[] = []
  private valid = 0

  constructor(public grammar: Grammar, private lineText: (i: number) => string, private lineCount: () => number) {
    this.reset()
  }

  reset() {
    this.starts = new Array(this.lineCount() + 1).fill('root')
    this.tokens = new Array(this.lineCount())
    this.valid = 0
  }

  setGrammar(g: Grammar) {
    this.grammar = g
    this.reset()
  }

  /** Lines [fromLine, fromLine+oldLines) were replaced by newLines lines. */
  edit(fromLine: number, oldLines: number, newLines: number) {
    this.starts = splice(this.starts, fromLine + 1, oldLines, newLines, 'root')
    this.tokens = splice(this.tokens, fromLine, oldLines, newLines, undefined)
    this.valid = Math.min(this.valid, fromLine)
  }

  /** Tokens of a line, tokenizing the lines above it when needed. */
  get(line: number): Token[] {
    const n = this.lineCount()
    if (line >= n) return []
    while (this.valid <= line) {
      const i = this.valid
      const { tokens, end } = this.grammar.line(this.lineText(i), this.starts[i] ?? 'root')
      this.tokens[i] = tokens
      this.starts[i + 1] = end
      this.valid++
    }
    return this.tokens[line] ?? []
  }

  /** State at the start of a line (used to know whether a position is in a string or comment). */
  stateAt(line: number) {
    this.get(Math.max(0, line - 1))
    return this.starts[line] ?? 'root'
  }
}

/** Replaces n items at i by m copies of fill, without spreading (large pastes). */
function splice<T>(a: T[], i: number, n: number, m: number, fill: T): T[] {
  if (n === m) {
    for (let k = i; k < i + m && k < a.length; k++) a[k] = fill
    return a
  }
  const out = new Array<T>(a.length - n + m)
  for (let k = 0; k < i; k++) out[k] = a[k]
  for (let k = 0; k < m; k++) out[i + k] = fill
  for (let k = i + n; k < a.length; k++) out[k - n + m] = a[k]
  return out
}
