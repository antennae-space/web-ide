// Plugins (#113): the test plugin hello (WEBIDE_TEST_PLUGINS) adds a tool in the right zone, an
// RPC method and an assistant tool of the MCP; disabled on the project in Settings > Plugins,
// its icon, its command and its tool go, its place in the zone stays. A built-in plugin disabled
// (Previews) is not downloaded (#124). Exec (#116) is locked (#137): its
// terminal and the Console tool stay, and the tools that need terminal always answer.
// Search (#117) gives Search Everywhere its Text tab: off, the tab and the Search tool go. Git
// (#118) gives the diff view its git sides: off, a diff tab says so, open_diff is refused.
// Previews (#119) needs terminal: off, its tool and list_previews go. Languages
// (#120): off, Problems, Structure, the Symbols tab and the code actions go, the editor still edits.
// Files and Code (#121) are locked, like Exec; the Explorer takes the colors of Git and the terminal of Exec.
// Status bar items (#127): hello's while its tool has the focus, a ticket's status, priority and
// size changed from the bar. Kanban (#122): off, its tool and the kanban_* tools go, a ticket tab says its plugin is off;
// a ticket tab of a desk saved before is migrated. AI (#123): off, no Assistant nor Agents, the
// MCP still answers (a doodle apart).
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { run, openProject, open, assert, mcp, WS } = require('../common.cjs')

const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r)
const tools = () =>
  fetch(process.env.E2E_URL + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.E2E_TOKEN },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
    .then((r) => r.json())
    .then((r) => r.result.tools.map((t) => t.name))

run(async ({ page }) => {
  await openProject(page)
  const icon = '.rail-group[data-zone=right] .rail-btn[data-id=hello]'

  // The tool of the plugin, after those of the core in its zone, renders what its backend answers.
  await page.waitForSelector(icon)
  const ids = await page.$$eval('.rail-group[data-zone=right] .rail-btn', (l) => l.map((b) => b.dataset.id))
  assert(ids.at(-1) === 'hello', 'the plugin tool comes last in its zone: ' + ids)
  await page.click(icon)
  await page.waitForFunction(() => document.querySelector('[data-testid=hello-text]')?.textContent === 'Hello plugin from demo')
  // Its item of the status bar, only while the tool has the focus.
  await page.click('[data-testid=hello-text]')
  await page.waitForSelector('[data-testid=status-bar] [data-testid=status-hello]')
  await page.click('.pane.active').catch(() => {})
  await page.waitForSelector('[data-testid=status-hello]', { state: 'detached' })

  // The items the plugin adds to the ⋮ menu of its tool, after the core ones (#175), and the
  // button it puts in the corner of its zone (#176).
  await page.waitForSelector('[data-tool=hello] [data-testid=zone-menu]')
  const helloCorner = await page.$$eval('[data-tool=hello] .zone-corner button', (b) => b.map((x) => x.getAttribute('data-testid')))
  assert(JSON.stringify(helloCorner) === JSON.stringify(['hello-corner', 'zone-menu', 'zone-close']), 'the corner group of the plugin tool: ' + JSON.stringify(helloCorner))
  await page.click('[data-tool=hello] [data-testid=zone-menu]')
  await page.waitForSelector('.ctx-menu')
  const helloMenu = await page.$$eval('.ctx-menu .ctx-item .ctx-label', (els) => els.map((e) => e.textContent.trim()))
  assert(
    JSON.stringify(helloMenu) === JSON.stringify(['Open in a window', 'Close', 'Say hello from the menu', 'Greet twice']),
    'the menu of the plugin tool: ' + JSON.stringify(helloMenu),
  )
  await page.click('.ctx-menu >> text=Greet twice')
  await page.waitForFunction(() => document.querySelector('[data-testid=hello-text]')?.textContent === 'Hello plugin from demo Hello plugin from demo')
  assert(true, 'the contributed item changed the tool')

  // Its assistant tool in the MCP, run on the project of the cwd.
  assert((await tools()).includes('hello_greet'), 'hello_greet listed by the MCP')
  let r = await mcp('hello_greet', { name: 'Claude' })
  assert(!r.result.isError && text(r) === 'Hello Claude from demo', 'hello_greet: ' + text(r))

  // Its command in Search Everywhere.
  const palette = async (q) => {
    await page.waitForTimeout(300)
    await page.keyboard.press('Control+Shift+a')
    await page.click('.pick.se .pick-input')
    await page.keyboard.press('Control+a')
    await page.keyboard.type(q)
  }
  // Settings closed by their button (the focus may be on the page after a change).
  const closeSettings = async () => {
    await page.click('.modal-settings .modal-head button[title^="Close"]')
    await page.waitForSelector('.modal-settings', { state: 'detached' })
  }
  await palette('hello')
  await page.waitForSelector('.pick-item:has-text("Hello")')
  await page.keyboard.press('Escape')

  // Disabled in Settings > Plugins: the icon goes, the MCP refuses the tool on this project.
  await palette('settings')
  await page.waitForSelector('.pick-item.selected:has-text("Settings")')
  await page.keyboard.press('Enter')
  await page.click('.settings-nav button:has-text("Plugins")')
  await page.uncheck('[data-testid=plugin-hello]')
  await page.waitForSelector(icon, { state: 'detached' })
  const saved = JSON.parse(fs.readFileSync(WS + '/demo/.ide/plugins.json', 'utf8'))
  assert(JSON.stringify(saved.disabled) === '["hello"]', 'disabled in .ide/plugins.json: ' + JSON.stringify(saved))
  r = await mcp('hello_greet', {})
  assert(r.result.isError && text(r).includes('the Hello plugin is disabled on this project'), 'refused when disabled: ' + text(r))
  await closeSettings()

  // Still off after a reload.
  await page.reload()
  await page.waitForSelector('.rail-group[data-zone=right] .rail-btn[data-id=info]')
  assert(!(await page.$(icon)), 'still disabled after a reload')

  // Enabled again: back at its place.
  await palette('settings')
  await page.waitForSelector('.pick-item.selected:has-text("Settings")')
  await page.keyboard.press('Enter')
  await page.click('.settings-nav button:has-text("Plugins")')
  await page.check('[data-testid=plugin-hello]')
  await page.waitForSelector(icon)
  r = await mcp('hello_greet', {})
  assert(!r.result.isError, 'enabled again: ' + text(r))
  await closeSettings()

  // A built-in disabled (Previews): its page module is not downloaded (#124); enabled, it is.
  const forwards = '.rail-group[data-zone=bottomRight] .rail-btn[data-id=forwards]'
  await page.waitForSelector(forwards)
  const setPlugin = async (id, on) => {
    await palette('settings')
    await page.waitForSelector('.pick-item.selected:has-text("Settings")')
    await page.keyboard.press('Enter')
    await page.click('.settings-nav button:has-text("Plugins")')
    await (on ? page.check(`[data-testid=plugin-${id}]`) : page.uncheck(`[data-testid=plugin-${id}]`))
    await closeSettings()
  }
  await setPlugin('previews', false)
  await page.waitForSelector(forwards, { state: 'detached' })
  const asked = []
  const onRequest = (q) => asked.push(q.url())
  page.on('request', onRequest)
  await page.reload()
  await page.waitForSelector('.rail-btn[data-id=explorer]')
  assert(asked.some((u) => /plugin-exec-/.test(u)) && !asked.some((u) => /plugin-previews-/.test(u)), 'no chunk of a disabled plugin: ' + asked.filter((u) => u.includes('plugin-')).map((u) => u.split('/').pop()))
  await setPlugin('previews', true)
  await page.waitForSelector(forwards)
  assert(asked.some((u) => /plugin-previews-/.test(u)), 'its chunk once enabled')
  page.off('request', onRequest)

  // Exec is locked (#137): a terminal opens, the Console tool stays with its dependents, and the
  // console tools of the MCP answer.
  page.on('dialog', (d) => d.accept())
  await page.click('.pane.active .ed-content').catch(() => {})
  await page.keyboard.press('Control+Shift+N')
  await page.waitForSelector('[data-testid=cmd-launcher]')
  await page.click('[data-testid=cmd-tile]:has-text("New terminal")') // the new tab becomes a terminal
  await page.waitForSelector('.xterm-helper-textarea')
  await page.waitForTimeout(500)
  await page.keyboard.type('echo plugin-$((6*7))')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('plugin-42'))
  const consoleIcon = '.rail-btn[data-id=console]'
  assert(await page.$(consoleIcon), 'the Console tool of a locked plugin')
  assert(await page.$(forwards), 'Previews stays (terminal is always on)')
  r = await mcp('list_consoles', {})
  assert(!r.result.isError, 'list_consoles answers: ' + text(r))
  await page.waitForSelector(consoleIcon)
  if (!(await page.isVisible('.xterm-rows'))) await page.click(consoleIcon)
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('plugin-42'))

  // Search: its tool in the left zone, before Git; the Text tab of Search Everywhere is its.
  const seTabs = async () => {
    await palette('x')
    await page.waitForSelector('.pick.se')
    const list = await page.$$eval('.se-tab', (l) => l.map((b) => b.textContent))
    await page.keyboard.press('Escape')
    return list
  }
  const left = await page.$$eval('.rail-group[data-zone=left] .rail-btn', (l) => l.map((b) => b.dataset.id))
  assert(left.indexOf('search') === left.indexOf('git') - 1, 'Search before Git: ' + left)
  assert(JSON.stringify(await seTabs()) === JSON.stringify(['All', 'Files', 'Symbols', 'Actions', 'Text']), 'the tabs of Search Everywhere')
  await setPlugin('search', false)
  await page.waitForSelector('.rail-btn[data-id=search]', { state: 'detached' })
  assert(JSON.stringify(await seTabs()) === JSON.stringify(['All', 'Files', 'Symbols', 'Actions']), 'no Text tab with Search off')
  await palette('notes')
  await page.keyboard.press('Shift+Tab') // Symbols
  await page.keyboard.press('Shift+Tab') // Files
  await page.waitForSelector('.se-tab.active:has-text("Files")')
  await page.waitForSelector('.pick-item:has-text("notes.txt")')
  await page.keyboard.press('Escape')
  await setPlugin('search', true)
  await page.waitForSelector('.rail-btn[data-id=search]')
  assert((await seTabs()).includes('Text'), 'the Text tab is back')

  // Git: a diff tab of a change, then Git off (its dependents named in a confirmation): no Git
  // tool, the tab falls back, open_diff refused, Kanban off for want of worktrees.
  fs.appendFileSync(WS + '/demo/notes.txt', 'a line for the diff\n')
  r = await mcp('open_diff', { path: 'notes.txt' })
  assert(!r.result.isError, 'open_diff: ' + text(r))
  await page.waitForSelector('.diff-view .diff-line.add:has-text("a line for the diff")')
  assert((await page.textContent('.diff-view .toolbar')).includes('working tree'), 'the label of the git source')
  await setPlugin('git', false)
  await page.waitForSelector('.rail-btn[data-id=git]', { state: 'detached' })
  await page.waitForSelector('.pane:has-text("The plugin of this tab is disabled")')
  assert(!(await page.$('.rail-btn[data-id=kanban]')), 'Kanban off with Git')
  r = await mcp('open_diff', { path: 'notes.txt' })
  assert(r.result.isError && text(r).includes('Git plugin is off'), 'open_diff refused: ' + text(r))
  r = await mcp('kanban_list', {})
  assert(r.result.isError && text(r).includes('the Kanban plugin is disabled'), 'kanban_list refused: ' + text(r))
  await palette('settings')
  await page.waitForSelector('.pick-item.selected:has-text("Settings")')
  await page.keyboard.press('Enter')
  await page.click('.settings-nav button:has-text("Plugins")')
  assert((await page.textContent('[data-plugin=kanban]')).includes('needs worktrees'), 'Kanban says what it lacks')
  await closeSettings()
  await setPlugin('git', true)
  await page.waitForSelector('.diff-view .diff-line.add:has-text("a line for the diff")')
  await page.waitForSelector('.rail-btn[data-id=git]')
  await page.waitForSelector('.rail-btn[data-id=kanban]')

  // Previews: off, its tool goes and list_previews is refused; on again, both are back.
  assert(!text(await mcp('list_previews', {})).includes('terminal'), 'list_previews answers')
  await setPlugin('previews', false)
  await page.waitForSelector(forwards, { state: 'detached' })
  r = await mcp('list_previews', {})
  assert(r.result.isError && text(r).includes('previews'), 'list_previews refused: ' + text(r))
  await setPlugin('previews', true)
  await page.waitForSelector(forwards)
  assert(!(await mcp('list_previews', {})).result.isError, 'list_previews back')

  // Languages: off, its tools, the Symbols tab and Find usages of the editor menu go; the editor
  // still edits; on again, they are back.
  const problems = '.rail-btn[data-id=problems]'
  const structure = '.rail-btn[data-id=structure]'
  await page.waitForSelector(problems)
  await page.waitForSelector(structure)
  assert((await seTabs()).includes('Symbols'), 'the Symbols tab')
  await setPlugin('languages', false)
  await page.waitForSelector(problems, { state: 'detached' })
  assert(!(await page.$(structure)), 'no Structure')
  assert(!(await seTabs()).includes('Symbols'), 'no Symbols tab with Languages off')
  await open(page, 'notes.txt')
  await page.click('.pane.active .ed-content', { button: 'right', position: { x: 40, y: 10 } })
  await page.waitForSelector('.ctx-menu')
  const menu = await page.$$eval('.ctx-menu .ctx-item', (l) => l.map((b) => b.textContent))
  assert(!menu.some((x) => x.includes('Find usages')) && menu.some((x) => x.includes('Copy')), 'no code actions in the editor menu: ' + menu.join(', '))
  await page.keyboard.press('Escape')
  await page.click('.pane.active .ed-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('typed without servers')
  await page.waitForFunction(() => document.querySelector('.pane.active .ed-content')?.textContent.includes('typed without servers'))
  await setPlugin('languages', true)
  await page.waitForSelector(problems)
  assert((await seTabs()).includes('Symbols'), 'the Symbols tab is back')

  // Files, Code and Exec are locked: checked and greyed.
  await palette('settings')
  await page.waitForSelector('.pick-item.selected:has-text("Settings")')
  await page.keyboard.press('Enter')
  await page.click('.settings-nav button:has-text("Plugins")')
  for (const id of ['files', 'code', 'exec']) {
    const box = await page.$(`[data-testid=plugin-${id}]`)
    assert((await box.isChecked()) && (await box.isDisabled()), id + ' locked')
  }
  assert((await page.textContent('[data-plugin=files]')).includes('Always on'), 'Always on')
  await closeSettings()

  // The Explorer: the colors are Git's, "Open a terminal here" is Exec's.
  fs.writeFileSync(WS + '/demo/untracked.txt', 'new\n')
  const untracked = `.explorer .tree-row[data-path="${WS}/demo/untracked.txt"] .tree-name`
  if (!(await page.isVisible('.explorer'))) await page.click('.rail-btn[data-id=explorer]')
  await page.waitForSelector(untracked + '.git-untracked')
  await setPlugin('git', false)
  await page.waitForSelector(untracked + '.git-clean')
  await setPlugin('git', true)
  await page.waitForSelector(untracked + '.git-untracked')
  const terminalItem = async () => {
    await page.click(untracked, { button: 'right' })
    await page.waitForSelector('.ctx-menu')
    const has = await page.isVisible('.ctx-menu .ctx-item:has-text("Open a terminal here")')
    await page.keyboard.press('Escape')
    return has
  }
  assert(await terminalItem(), 'a terminal here (Exec is locked)')

  // Kanban: a ticket opened from its tool; off, the tool, the view and kanban_list go; on, back.
  r = await mcp('kanban_create', { title: 'Plugin ticket' })
  const id = Number(/#(\d+)/.exec(text(r))[1])
  await page.click('.rail-btn[data-id=kanban]')
  await page.click(`[data-testid=kanban-panel] [data-testid=ticket-card-${id}]`)
  await page.waitForSelector(`[data-testid=ticket-view] .tk-num:has-text("#${id}")`)
  assert((await page.textContent('.tab.active .tab-title')).startsWith(`#${id} Plugin ticket`), 'ticket tab titled by the plugin')
  // The ticket in the status bar: its status, priority and size, changed through their menus.
  await page.click('[data-testid=ticket-view] .tk-num')
  await page.waitForSelector('[data-testid=status-ticket-status]:has-text("New")')
  assert((await page.textContent('[data-testid=status-ticket-size]')) === 'Size not estimated', 'size in the bar')
  await page.click('[data-testid=status-ticket-priority]')
  await page.click('.ctx-menu .ctx-item:has-text("High priority")')
  await page.waitForSelector('[data-testid=status-ticket-priority]:has-text("High priority")')
  await page.click('[data-testid=status-ticket-status]')
  await page.click('.ctx-menu .ctx-item:has-text("To do")')
  await page.waitForSelector('.modal-small input')
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-testid=status-ticket-status]:has-text("To do")')
  assert((await page.getAttribute('[data-testid=ticket-view]', 'data-status')) === 'todo', 'the view follows the status changed in the bar')
  await setPlugin('kanban', false)
  await page.waitForSelector('.rail-btn[data-id=kanban]', { state: 'detached' })
  await page.waitForSelector('.pane:has-text("The plugin of this tab is disabled")')
  r = await mcp('kanban_list', {})
  assert(r.result.isError && text(r).includes('the Kanban plugin is disabled'), 'kanban_list refused: ' + text(r))
  await setPlugin('kanban', true)
  await page.waitForSelector(`[data-testid=ticket-view] .tk-num:has-text("#${id}")`)
  assert(!(await mcp('kanban_list', {})).result.isError, 'kanban_list back')

  // AI: off, no Assistant nor Agents, the MCP still answers but a doodle (the AI's); on, back.
  if (!(await page.isVisible('.ai-panel'))) await page.click('.rail-btn[data-id=assistant]')
  await page.waitForSelector('.ai-panel')
  await setPlugin('ai', false)
  await page.waitForSelector('.rail-btn[data-id=assistant]', { state: 'detached' })
  assert(!(await page.$('.rail-btn[data-id=agents]')) && !(await page.$('.ai-panel')), 'no Assistant nor Agents with AI off')
  assert(!(await mcp('kanban_list', {})).result.isError, 'the MCP answers with AI off')
  r = await mcp('request_doodle', { title: 'x' })
  assert(r.result.isError && text(r).includes('needs the assistant capability'), 'request_doodle refused: ' + text(r))
  // A briefing asked from a ticket says AI is off, nothing breaks.
  const nid = Number(/#(\d+)/.exec(text(await mcp('kanban_create', { title: 'Without AI' })))[1])
  if (!(await page.isVisible('[data-testid=kanban-panel]'))) await page.click('.rail-btn[data-id=kanban]')
  await page.click(`[data-testid=kanban-panel] [data-testid=ticket-card-${nid}]`)
  await page.click('[data-testid=ticket-view] [data-testid=ticket-briefing]')
  await page.waitForSelector('.toast:has-text("The AI plugin is disabled")')
  await page.click(`.tab:has-text("#${id} Plugin ticket")`)
  await setPlugin('ai', true)
  await page.waitForSelector('.rail-btn[data-id=assistant]')
  if (!(await page.isVisible('.ai-panel'))) await page.click('.rail-btn[data-id=assistant]')
  await page.waitForSelector('.ai-panel')
  assert(await page.isVisible('.rail-btn[data-id=agents]'), 'Agents back')

  // A desk saved before #122 (a tab of kind ticket) opens the ticket view of the plugin.
  await page.waitForTimeout(800)
  const dir = path.join(process.env.E2E_DATA, 'desks')
  const deskFile = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => fs.readFileSync(f, 'utf8').includes('plugin:kanban/ticket'))
  const podPid = fs.readFileSync(path.join(process.env.E2E_TMP, 'pod.pid'), 'utf8').trim()
  execSync(`kill -TERM ${podPid}; while kill -0 ${podPid} 2>/dev/null; do sleep 0.1; done`)
  const old = JSON.parse(fs.readFileSync(deskFile, 'utf8'))
  for (const t of Object.values((old.session ?? old).tabs)) {
    if (t.kind !== 'plugin:kanban/ticket') continue
    Object.assign(t, { kind: 'ticket', ticket: t.state.ticket })
    delete t.state
    delete t.key
  }
  fs.writeFileSync(deskFile, JSON.stringify(old))
  execSync(`bash ${path.join(process.env.E2E_TMP, 'launch-pod.sh')}`)
  await page.reload()
  await page.waitForSelector(`[data-testid=ticket-view] .tk-num:has-text("#${id}")`, { timeout: 15000 })
})
