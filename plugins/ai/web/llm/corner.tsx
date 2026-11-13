// The corner of the Assistant tool (docs/design/plugins.md, `toolCorner` #176): a new conversation
// and its settings. The state lives here rather than in AssistantTool, since the core draws the
// corner of the zone or of the tile outside the tool.
import type { JSX } from 'solid-js'
import { createSignal } from 'solid-js'
import { resetChat } from './state'
import { focusComposer } from './Composer'
import { Icon, t } from '../plugin'

/** Whether the settings modal of the assistant is open (it is drawn by AssistantTool). */
export const [settingsOpen, setSettingsOpen] = createSignal(false)

/** A new conversation on this desk, with its message box focused. */
export function newConversation() {
  resetChat()
  focusComposer()
}

/** The buttons of the corner of the zone or of the tile showing the Assistant tool. */
export function AssistantCorner(): JSX.Element[] {
  return [
    <button class="icon-btn" title={t('New conversation')} onClick={newConversation} data-testid="assistant-new">
      <Icon name="plus" size={15} />
    </button>,
    <button class="icon-btn" title={t('Settings (servers, prompt, compaction, transcription)')} onClick={() => setSettingsOpen(true)} data-testid="assistant-settings">
      <Icon name="gear" size={15} />
    </button>,
  ]
}
