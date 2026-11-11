import { createEffect, onCleanup } from 'solid-js'
import { onMarkdownClick, renderMarkdown, renderMermaid } from './markdown'
import './markdown.css'

/**
 * Markdown rendered at most once per frame while it streams; diagrams drawn as they close.
 * remoteImages false: the text of a model, its remote images become links.
 */
export function Markdown(props: { text: string; final: boolean; remoteImages?: boolean }) {
  let el!: HTMLDivElement
  let frame = 0
  createEffect(() => {
    const text = props.text
    const final = props.final
    const remoteImages = props.remoteImages
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      el.innerHTML = renderMarkdown(text, { remoteImages })
      renderMermaid(el, final).catch(() => {})
    })
  })
  onCleanup(() => cancelAnimationFrame(frame))
  return <div class="md" ref={el} onClick={onMarkdownClick} />
}
