// The glyph of a symbol kind: the letter of web/kinds.json in a disc colored by its family.
// The Structure tool and the Symbols tab of Search Everywhere show symbols this way.
import { t } from './plugin'
import { symbolKinds } from './client'

export function SymGlyph(props: { kind: number }) {
  const k = () => symbolKinds[props.kind]
  return (
    <span class={`sym-glyph f-${k()?.[2] ?? 'other'}`} title={t(k()?.[0] ?? '')}>
      {k()?.[1] ?? '·'}
    </span>
  )
}
