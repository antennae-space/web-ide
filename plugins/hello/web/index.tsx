// The plugin of the browser tests (pod/plugins/hello): a tool calling its backend, an item of the
// status bar while the tool has the focus, and items it adds to the ⋮ menu of its tool.
import { createResource, createSignal } from 'solid-js'
import type { PluginModule } from '@ide/types'

export const hello: PluginModule = {
  activate(api) {
    // "Greet twice": a choice of the menu, read by the tool below.
    const [twice, setTwice] = createSignal(false)
    function HelloTool() {
      const [text] = createResource(() => api.rpc<{ text: string }>('greet', { name: 'plugin' }).then((r) => r.text))
      return (
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">Hello</span>
          </div>
          <div class="panel-body pad" data-testid="hello-text">
            {twice() ? `${text()} ${text()}` : text()}
          </div>
        </div>
      )
    }
    return {
      tools: { hello: { component: HelloTool } },
      toolStatus: { hello: () => [{ id: 'hello', testid: 'status-hello', text: 'Hello', menu: () => [{ label: 'Hi', action: () => {} }] }] },
      toolMenu: {
        hello: () => [
          { label: api.t('Say hello from the menu'), action: () => api.ui.toast(api.t('Hello from the menu')) },
          { label: api.t('Greet twice'), checked: twice(), action: () => setTwice(!twice()) },
        ],
      },
      // One button in the corner of its zone or tile, before the ⋮ (toolCorner, #176).
      toolCorner: {
        hello: () => [<button class="icon-btn" data-testid="hello-corner" title={api.t('Say hello')} onClick={() => api.ui.toast(api.t('Hello from the corner'))} />],
      },
    }
  },
}
