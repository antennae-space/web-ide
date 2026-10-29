// Saved commands of the project: the new tab of the Console and its launcher (grid of tiles,
// groups by flag, keyboard, a pick converts the tab), modal list + detail (bash editor), one
// console per command with Restart in the same tab, ad hoc command saved, .ide/commands.json;
// the commands in Search Everywhere and their shortcuts.
const fs = require('fs')
const { run, openProject, assert, OUT, WS } = require('../../../e2e/common.cjs')

const demo = WS + '/demo'
const file = demo + '/.ide/commands.json'
const tabs = (page) => page.$$eval('.console-tabs .tab .tab-title', (l) => l.map((e) => e.textContent))
const tiles = (page) => page.$$eval('[data-testid=cmd-launcher] .cmd-tile-name', (l) => l.map((e) => e.textContent))
const tile = (name) => `[data-testid=cmd-launcher] [data-testid=cmd-tile]:has-text("${name}")`
/** + (or Ctrl+Shift+N): the new tab shown, the launcher under the keyboards. */
const newTab = async (page) => {
  await page.click('[data-testid=console-new-tab-button]')
  await page.waitForSelector('[data-testid=cmd-launcher]')
  await page.waitForTimeout(200)
}

run(async ({ page }) => {
  // Dialogs (confirm): answered by `answer`, their text kept in `asked`.
  let asked = ''
  let answer = true
  page.on('dialog', (d) => ((asked = d.message()), answer ? d.accept() : d.dismiss()))
  await openProject(page)
  if (!(await page.isVisible('.console-tabs'))) await page.keyboard.press('Alt+F12')
  await page.waitForSelector('[data-testid=cmd-launcher]')
  // The tool shown takes the keyboard a few frames later: typing in the modal waits for it.
  await page.waitForTimeout(500)

  // The Console is never empty: its only tab is the new one, showing the launcher.
  assert((await tabs(page)).join() === 'New tab', 'the new tab is the least the Console holds: ' + (await tabs(page)))
  assert(!(await page.isVisible('[data-testid=console-commands]')), 'no ▶ button anymore')
  assert((await tiles(page)).join() === 'New terminal,Create a command…', 'empty launcher: ' + (await tiles(page)))
  assert(await page.evaluate(() => document.activeElement?.classList.contains('cmd-tile') && document.activeElement?.textContent?.includes('New terminal')), 'New terminal focused when the launcher opens')
  await page.click('[data-testid=cmd-tile]:has-text("Create a command")')
  await page.waitForSelector('.cmd-modal [data-testid=cmd-name]')

  // First command, from the empty state: a long-running server in a sub-folder.
  await page.fill('[data-testid=cmd-name]', 'Dev server')
  await page.selectOption('[data-testid=cmd-flag]', 'serve')
  await page.fill('[data-testid=cmd-description]', 'Prints its folder then waits')
  await page.fill('[data-testid=cmd-cwd]', 'src')
  await page.fill('[data-testid=cmd-port]', '5173')
  await page.click('[data-testid=cmd-command] .ed-content')
  await page.keyboard.type('echo "dev in $(pwd)"\nsleep 300')
  assert(await page.isVisible('[data-testid=cmd-command] .ed-content'), 'command in the editor of the IDE')
  const highlighted = await page.evaluate(() => [...(CSS.highlights?.keys() ?? [])].some((k) => /string|keyword|variable/.test(k)))
  assert(highlighted, 'bash highlighted')

  // Second one, duplicated then changed: a build that ends.
  await page.click('[data-testid=cmd-duplicate]')
  await page.fill('[data-testid=cmd-name]', 'Build')
  await page.selectOption('[data-testid=cmd-flag]', 'build')
  await page.fill('[data-testid=cmd-cwd]', '')
  await page.click('[data-testid=cmd-command] .ed-content')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('echo built-ok')
  // Order: Alt+↑ moves Build first.
  await page.click('.cmd-item.selected')
  await page.keyboard.press('Alt+ArrowUp')
  const names = () => page.$$eval('[data-testid=cmd-item] .cmd-item-name', (l) => l.map((e) => e.textContent))
  assert((await names()).join() === 'Build,Dev server', 'Alt+↑ reorders: ' + (await names()))
  await page.screenshot({ path: OUT + '/commands-modal.png' })
  await page.click('[data-testid=cmd-save]')
  await page.waitForSelector('[data-testid=cmd-save]:disabled')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).commands
  assert(saved.length === 2 && saved[0].name === 'Build' && !saved[0].port && saved[1].cwd === 'src' && saved[1].port === 5173 && saved[1].command === 'echo "dev in $(pwd)"\nsleep 300', 'saved in .ide/commands.json: ' + JSON.stringify(saved))
  assert(fs.readFileSync(demo + '/.ide/.gitignore', 'utf8').includes('*'), '.ide ignored by git')

  // Unsaved changes: closing asks.
  await page.fill('[data-testid=cmd-name]', 'Build!')
  answer = false
  await page.keyboard.press('Escape')
  for (let end = Date.now() + 5000; !/unsaved/.test(asked) && Date.now() < end; ) await page.waitForTimeout(100)
  assert(/unsaved/.test(asked) && (await page.isVisible('.cmd-modal')), 'closing with unsaved changes asks')
  answer = true
  await page.click('.cmd-modal .modal-foot button:has-text("Cancel")')
  await page.waitForSelector('.cmd-modal', { state: 'detached' })

  // The launcher of the new tab: New terminal, the commands in the saved order, then the rest.
  await page.waitForSelector('[data-testid=cmd-launcher]')
  await page.waitForTimeout(300)
  assert((await tiles(page)).join() === 'New terminal,Build,Dev server,Run a command…,Edit commands…', 'grid: ' + (await tiles(page)))
  assert(await page.evaluate(() => document.activeElement?.classList.contains('cmd-tile') && document.activeElement?.textContent?.includes('New terminal')), 'New terminal focused when the launcher opens')
  // Arrows move the focus in the grid, Enter runs the tile focused: two steps reach Dev server.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  assert(await page.evaluate(() => document.activeElement?.classList.contains('cmd-tile') && document.activeElement?.textContent?.includes('Dev server')), 'arrows move the focus in the grid')
  await page.keyboard.press('Enter')
  // The new tab converted into the console of the command: it is the only tab.
  await page.waitForSelector('.console-tabs .tab.active:has-text("Dev server")')
  assert((await tabs(page)).join() === 'Dev server', 'the new tab converted into the console: ' + (await tabs(page)))
  await page.waitForFunction(() => /dev in .*\/demo\/src/.test(document.querySelector('.term-slot[style*="block"] .xterm-rows')?.textContent ?? ''), null, { timeout: 10000 })
  assert(true, 'the command runs in its folder')

  // + opens a new tab above the open consoles: running dot, screen button of the serve command.
  await newTab(page)
  assert((await tabs(page)).join() === 'Dev server,New tab', 'the new tab joins the consoles: ' + (await tabs(page)))
  assert((await page.textContent(tile('Dev server') + ' [data-testid=cmd-badge]')) === '●', 'running command marked on its tile')
  assert(await page.isVisible(tile('Dev server') + ' [data-testid=cmd-tile-app]'), 'a serve command with a port gets its preview button')
  assert(!(await page.isVisible(tile('Build') + ' [data-testid=cmd-tile-app]')), 'not a build command')
  await page.screenshot({ path: OUT + '/commands-launcher.png' })
  await page.click(tile('Build'))
  await page.waitForSelector('.console-tabs .tab.active:has-text("Build")')
  await page.waitForSelector('.console-tabs .tab:has-text("Build") .ok')
  assert((await tabs(page)).join() === 'Dev server,Build', 'the new tab converted in its place: ' + (await tabs(page)))

  // Escape with nothing to back out of: the focus goes back to the editor.
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.pick-input')
  await page.keyboard.type('main.go')
  await page.waitForSelector('.pick-item:has-text("main.go")')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.pane .ed-content')
  await newTab(page)
  await page.keyboard.press('Escape')
  assert(!(await page.evaluate(() => document.activeElement?.closest?.('.cmd-launcher'))), 'Escape gives the focus back to the editor')
  assert(await page.isVisible('[data-testid=cmd-launcher]'), 'the new tab stays open')

  // Typing filters across the groups; Escape clears the filter first.
  await page.click('.console-tabs [data-testid=console-new-tab]')
  await page.waitForTimeout(200)
  await page.keyboard.type('dev')
  await page.waitForSelector('[data-testid=cmd-query]')
  assert((await tiles(page)).join() === 'Dev server', 'typing filters across the groups: ' + (await tiles(page)))
  await page.keyboard.press('Escape')
  assert((await tiles(page)).join() === 'New terminal,Build,Dev server,Run a command…,Edit commands…', 'Escape clears the filter: ' + (await tiles(page)))

  // Exit code of the console of a command, while it is listed.
  assert((await page.textContent(tile('Build') + ' [data-testid=cmd-badge]')) === '0', 'exit code on the tile of the ended command')

  // Running again: Restart offered; the console keeps the place of its tab.
  asked = ''
  await page.click(tile('Dev server'))
  await page.waitForFunction(() => document.querySelectorAll('.console-tabs .tab').length === 2 && document.querySelector('.console-tabs .tab.active')?.textContent.includes('Dev server'))
  assert(/Restart/.test(asked), 'Restart asked: ' + asked)
  assert((await tabs(page)).join() === 'Dev server,Build', 'restarted in the same tab: ' + (await tabs(page)))
  // An ended command runs again without asking, in its tab.
  await newTab(page)
  asked = ''
  await page.click(tile('Build'))
  await page.waitForSelector('.console-tabs .tab.active:has-text("Build")')
  await page.waitForTimeout(300)
  assert(asked === '' && (await tabs(page)).length === 2, 'an ended command restarts without asking')

  // An ad hoc task, then saved as a command from the menu of its tab, under the build flag.
  await newTab(page)
  await page.click('[data-testid=cmd-tile]:has-text("Run a command")')
  await page.fill('.modal input', 'echo adhoc-1')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.console-tabs .tab.active:has-text("echo adhoc-1")')
  assert((await tabs(page)).join() === 'Dev server,Build,echo adhoc-1', 'the new tab converted into the task: ' + (await tabs(page)))
  await page.click('.console-tabs .tab:has-text("echo adhoc-1")', { button: 'right' })
  await page.click('.ctx-item:has-text("as a command")')
  await page.waitForSelector('.cmd-modal [data-testid=cmd-name]')
  assert((await page.inputValue('[data-testid=cmd-name]')) === 'echo adhoc-1', 'draft named after the command')
  await page.selectOption('[data-testid=cmd-flag]', 'build')
  await page.click('[data-testid=cmd-run]')
  await page.waitForSelector('.cmd-modal', { state: 'detached' })
  await page.waitForSelector('.console-tabs .tab.active:has-text("echo adhoc-1") .ok')
  assert(JSON.parse(fs.readFileSync(file, 'utf8')).commands.length === 3, 'Save and run saved the third command')

  // Two commands under one flag: one group tile, opened in place, back with Escape.
  await newTab(page)
  assert((await tiles(page)).join() === 'New terminal,build,Dev server,Run a command…,Edit commands…', 'one tile per flag: ' + (await tiles(page)))
  assert((await page.textContent('[data-testid=cmd-launcher] .cmd-tile.group [data-testid=cmd-tile-count]')) === '2', 'the group tile counts its commands')
  await page.click('[data-testid=cmd-tile].group')
  await page.waitForSelector('[data-testid=cmd-tile].back')
  assert((await tiles(page)).join() === 'Back,Build,echo adhoc-1', 'the group opens in place: ' + (await tiles(page)))
  await page.screenshot({ path: OUT + '/commands-group.png' })
  await page.keyboard.press('Escape')
  assert((await tiles(page)).join() === 'New terminal,build,Dev server,Run a command…,Edit commands…', 'Escape goes back to the groups: ' + (await tiles(page)))

  // Delete from the modal.
  await page.click('[data-testid=cmd-tile]:has-text("Edit commands")')
  await page.click('[data-testid=cmd-item]:has-text("Dev server")')
  assert(await page.isVisible('[data-testid=cmd-open-app]'), 'Start and open the app offered for a serve command with a port')
  await page.click('[data-testid=cmd-item]:has-text("echo adhoc-1")')
  assert(!(await page.isVisible('[data-testid=cmd-open-app]')), 'not for another command')
  await page.click('[data-testid=cmd-delete]')
  await page.click('[data-testid=cmd-save]')
  await page.waitForSelector('[data-testid=cmd-save]:disabled')
  assert(JSON.parse(fs.readFileSync(file, 'utf8')).commands.length === 2, 'command deleted')
  await page.screenshot({ path: OUT + '/commands-console.png' })
  await page.click('.cmd-modal .modal-foot button:has-text("Cancel")')
  await page.waitForSelector('.cmd-modal', { state: 'detached' })

  // Search Everywhere: one action per command, with its flag icon and description; Enter runs it.
  // A console just shown takes the keyboard a few frames later: the query is typed once it settled.
  const palette = async (q) => {
    await page.waitForTimeout(300)
    await page.keyboard.press('Control+Shift+a')
    await page.click('.pick.se .pick-input')
    await page.keyboard.press('Control+a')
    await page.keyboard.type(q)
  }
  await palette('build')
  await page.waitForSelector('.pick-item:has-text("Run: Build")')
  const hit = await page.textContent('.pick-item.selected')
  assert(hit.includes('Run: Build') && hit.includes('Prints its folder') && (await page.isVisible('.pick-item.selected .pick-icon svg')), 'command in Search Everywhere with its icon and description: ' + hit)
  await page.screenshot({ path: OUT + '/commands-search.png' })
  asked = ''
  await page.keyboard.press('Enter')
  await page.waitForSelector('.pick.se', { state: 'detached' })
  await page.waitForSelector('.console-tabs .tab.active:has-text("Build")')
  assert(asked === '', 'an ended command runs from Search Everywhere')
  await palette('dev server')
  await page.waitForSelector('.pick-item.selected:has-text("Run: Dev server")')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.console-tabs .tab.active')?.textContent.includes('Dev server'))
  assert(/Restart/.test(asked), 'a running command asks Restart from Search Everywhere: ' + asked)

  // Keymap settings: the commands under their category, no default shortcut; one is set.
  await palette('settings')
  await page.waitForSelector('.pick-item.selected:has-text("Settings")')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.settings')
  await page.click('.settings-nav button:has-text("Keyboard shortcuts")')
  await page.fill('.settings-body input[placeholder*="category"]', 'project commands')
  await page.waitForSelector('.keys-table tr:has-text("Run: Build")')
  const row = '.keys-table tr:has-text("Run: Build")'
  assert((await page.textContent(row)).includes('Project commands') && !(await page.$(row + ' kbd')), 'command in the keymap, no default shortcut')
  await page.click(row + ' button:has-text("+")')
  await page.keyboard.press('Control+Alt+Shift+B')
  await page.waitForSelector(row + ' kbd:has-text("Ctrl+Alt+Shift+B")')
  assert(true, 'shortcut set for a command')
  await page.click('.modal-settings .modal-head .icon-btn')
  await page.waitForSelector('.settings', { state: 'detached' })

  // Renamed, the command keeps its shortcut (bound by id), which runs it.
  await newTab(page)
  await page.click('[data-testid=cmd-tile]:has-text("Edit commands")')
  await page.click('[data-testid=cmd-item]:has-text("Build")')
  await page.fill('[data-testid=cmd-name]', 'Build all')
  await page.click('[data-testid=cmd-save]')
  await page.waitForSelector('[data-testid=cmd-save]:disabled')
  // Not Escape: the disabled Save button lost the focus, the key may not reach the modal.
  await page.click('.cmd-modal .modal-foot button:has-text("Cancel")')
  await page.waitForSelector('.cmd-modal', { state: 'detached' })
  await page.click('.console-tabs .tab:has-text("Dev server")')
  await page.keyboard.press('Control+Alt+Shift+B')
  await page.waitForSelector('.console-tabs .tab.active:has-text("Build all")')
  assert(true, 'the shortcut runs the renamed command, from a terminal')
  await palette('build all')
  await page.waitForSelector('.pick-item.selected:has-text("Run: Build all") kbd:has-text("Ctrl+Alt+Shift+B")')
  assert(true, 'Search Everywhere shows the shortcut of the command')
  await page.keyboard.press('Escape')

  // The palette command "Run a command…" (console.run) runs an ad hoc task.
  await palette('run a command')
  await page.waitForSelector('.pick-item.selected:has-text("Run a command…")')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.modal input')
  await page.fill('.modal input', 'echo palette-run')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.console-tabs .tab.active:has-text("echo palette-run") .ok')
  assert(true, 'console.run from the palette')

  // Ctrl+Shift+N: the new tab, Enter converts it into a terminal.
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+Shift+N')
  await page.waitForSelector('[data-testid=cmd-launcher]')
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !document.querySelector('[data-testid=console-new-tab]') && document.querySelectorAll('.console-tabs .tab').length >= 5, null, { timeout: 8000 })
  assert(!(await page.isVisible('[data-testid=console-new-tab]')), 'Ctrl+Shift+N + Enter: the new tab became a terminal')

  // Closing the consoles leaves the new tab: the Console is never empty.
  for (let i = 0; i < 8 && (await page.$('.console-tabs .tab:has(.tab-close)')); i++) {
    await page.click('.console-tabs .tab:has(.tab-close) .tab-close')
    await page.waitForTimeout(400)
  }
  assert((await tabs(page)).join() === 'New tab', 'the Console keeps a new tab: ' + (await tabs(page)))
  assert(await page.isVisible('[data-testid=cmd-launcher]'), 'the launcher is back')
})
