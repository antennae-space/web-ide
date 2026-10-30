// What the IDE does when a program stops (docs/design/debug.md#focus-on-a-stop): on the first stop
// of a session the Debug tool opens and takes the focus, the editor shows the line; when the
// window is hidden, a notification and a mark on the title of the tab of the browser. At the end
// of the last session the tool closes, unless the setting keeps it open. The pod sends the push
// notification to the devices that show no window.
import { api, setting, t } from './plugin'
import { debug, setDebug, viewOf } from './state'

/** The title of the tab of the browser before a stop marked it. */
let titleBefore: string | null = null

/** Brings the program's place up: the tool (first stop), the editor at the line, the notification. */
export function onStop(id: string, file: string, line: number) {
  const v = viewOf(id)
  const first = !!v && !v.stoppedOnce
  if (v) setDebug('views', id, 'stoppedOnce', true)
  if (file && line) void api.openFile({ path: file, line: line - 1 })
  if (first && setting('show_on_stop')) {
    setDebug('selected', id)
    setDebug('tab', 'frames')
    api.showTool('debug')
    // After the editor showed the line (it takes the focus when it reveals one).
    setTimeout(() => document.querySelector<HTMLElement>('[data-testid="debug-tool"]')?.focus(), 150)
  }
  if (document.hidden) notifyHidden(id, file, line)
}

function notifyHidden(id: string, file: string, line: number) {
  const where = `${api.project.basename(file || '')}${line ? ':' + line : ''}`
  if (titleBefore === null) titleBefore = document.title
  document.title = `⏸ ${t('Stopped at {where}', { where })} · ${titleBefore}`
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(t('The program stopped'), { body: t('Stopped at {where}', { where }), tag: `debug-${id}` })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  }
}

/** Asks for the permission of the notifications once, when the user starts a session. */
export function askNotifications() {
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => {})
}

/** Puts the title back when the window is seen again. */
export function watchVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && titleBefore !== null) {
      document.title = titleBefore
      titleBefore = null
    }
  })
}

/** A session ended: the tool closes with the last one, unless the setting keeps it. */
export function onEnd() {
  if (!debug.sessions.length && !setting('keep_open_at_end')) api.hideTool('debug')
}
