// The view of an image file (#226): the binary buffers of the file tabs that are images. The pod
// reads it as a data URL (`fs.image`, the one of the Markdown view), shown fitted to the pane on
// a checkered background; a click toggles the actual size. Read again when its folder changes on
// disk (an image generated again).
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { api, request, t } from './plugin'

/** The extensions `fs.image` reads (pod/assistant ImageTypes, SVG apart: it is text). */
const imageExt = /\.(png|jpe?g|webp|gif)$/i

export const isImagePath = (path: string) => imageExt.test(path)

export function ImageView(props: { path: string }) {
  const [url, setUrl] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [size, setSize] = createSignal<{ w: number; h: number }>()
  const [actual, setActual] = createSignal(false)
  /** Reads the image and decodes it before showing it: its size, and no blank while it loads. */
  const load = async () => {
    try {
      const { url } = await request<{ url: string }>('fs.image', { path: props.path })
      const img = new Image()
      img.src = url
      await img.decode()
      setSize({ w: img.naturalWidth, h: img.naturalHeight })
      setUrl(url)
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  onMount(() => {
    void load()
    // The pod tells a change of any file by its folder: read again, once the writes settle.
    const dir = props.path.slice(0, props.path.lastIndexOf('/'))
    let timer: number | undefined
    const off = api.on('fs.dir', (e: { path: string }) => {
      if (e.path !== dir) return
      clearTimeout(timer)
      timer = setTimeout(load, 300) as unknown as number
    })
    onCleanup(() => {
      clearTimeout(timer)
      off()
    })
  })
  return (
    <div class="image-view" data-testid="image-view">
      <Show when={!error()} fallback={<div class="empty-pane">{t('Cannot show the image: {error}', { error: error() ?? '' })}</div>}>
        <div class="image-stage" classList={{ actual: actual() }} onClick={() => setActual(!actual())} title={actual() ? t('Fit to the pane') : t('Actual size')}>
          <Show when={url()}>
            <img src={url()} alt="" />
          </Show>
        </div>
        <div class="image-info" data-testid="image-info">
          {size() ? t('{width} × {height} px', { width: size()!.w, height: size()!.h }) : ''}
        </div>
      </Show>
    </div>
  )
}
