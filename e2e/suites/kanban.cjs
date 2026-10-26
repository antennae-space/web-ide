// Kanban: board, new ticket, ticket view by status (the sections of the status, the earlier
// ones folded: description, notes, plan, goals, files, attachments), workflow buttons, test
// feedback, side panel, sync with a second window.
const fs = require('fs')
const { run, openProject, assert, mcp, unfold, WS, OUT, installOfficial, inFrames, acceptConfirms } = require('../common.cjs')

run(async ({ page, ctx }) => {
  // The views of the Kanban are frames of the page (#158).
  const kp = inFrames(page)
  // The Kanban is an external official plugin (#158): its release, or E2E_PLUGIN_KANBAN.
  await installOfficial('kanban')
  page.on('dialog', (d) => d.accept())
  acceptConfirms(page)
  await openProject(page)
  await kp.click('.rail-left .rail-btn[title="Kanban"]')
  await kp.waitForSelector('[data-testid=kanban-panel]')
  await kp.click('[data-testid=kanban-open-board]')
  await kp.waitForSelector('[data-testid=kanban-board]')
  assert((await kp.$$('.kb-col')).length === 4, 'four active columns: New, To do, In progress, To test')
  await kp.click('[data-testid=kanban-open-roadmap]')
  await kp.waitForSelector('[data-testid=kanban-view-roadmap][aria-pressed=true]')
  assert(true, 'the side panel opens the open board on the Roadmap')
  await kp.click('[data-testid=kanban-open-board]')
  await kp.waitForSelector('[data-testid=kanban-view-board][aria-pressed=true]')
  assert(true, 'and back on the Board')

  // New ticket.
  await kp.click('[data-testid=kanban-new]')
  await kp.fill('[data-testid=kanban-title]', 'CSV export of the orders')
  await kp.fill('[data-testid=kanban-description]', 'Add a CSV **export**.')
  await kp.click('[data-testid=kanban-create]')
  await kp.waitForSelector('[data-testid=ticket-view]')
  assert((await kp.textContent('[data-testid=ticket-title]')).includes('CSV export'), 'ticket opened in a tab')
  assert((await kp.textContent('[data-testid=ticket-status]')).includes('New'), 'status New')
  await kp.waitForSelector('[data-testid=ticket-description] strong', { timeout: 5000 })
  assert(true, 'description in Markdown')
  assert(await kp.isVisible('.pane.active .tab.active:has-text("#1")'), 'title of the tab')
  assert(fs.existsSync(WS + '/demo/.ide/kanban.db'), 'kanban.db base in .ide')
  assert(fs.readFileSync(WS + '/demo/.ide/.gitignore', 'utf8').includes('\n*\n'), '.ide ignored by git, kanban.db included')
  const sections = () => kp.$$eval('.tk-main .tk-section, .tk-main .tk-sep', (l) => l.map((e) => (e.matches('.tk-sep') ? '|' : (e.classList.contains('folded') ? '-' : '') + e.querySelector('.tk-section-toggle').textContent.trim())))
  assert((await sections()).join() === 'Description,Briefing conversations,Notes', 'New: description, briefing and notes, open: ' + (await sections()).join())
  const header = () => kp.$$eval('.tk-meta-row > .btn, .tk-meta-row > .tk-split > .btn:first-child', (l) => l.map((e) => e.textContent.trim()))
  assert((await header()).join() === 'Briefing,Generate the plan', 'New: Briefing and Generate the plan in the header: ' + (await header()).join())
  await kp.click('[data-testid=ticket-plan-generate-with]')
  assert(
    (await kp.$$eval(':is(.ctx-menu, .ide-menu) button', (l) => l.map((e) => e.textContent.trim()))).join() === 'With the integrated AI,With Claude Code (Opus)',
    'split button: the integrated AI or Claude Code',
  )
  await page.keyboard.press('Escape')
  assert((await kp.textContent('.tk-side')).match(/Lineage[\s\S]*Linked files[\s\S]*Attachments[\s\S]*History/), 'side: lineage, files, attachments, history')

  // Description limited to 1500 characters.
  await kp.click('[data-testid=ticket-description-edit]')
  await kp.fill('.tk-md-input', 'x'.repeat(1501))
  assert(await kp.isDisabled('[data-testid=ticket-description-save]'), 'description over 1500 characters cannot be saved')
  assert((await kp.textContent('[data-testid=ticket-description] .tk-count.over')).includes('1501/1500'), 'character counter')
  await kp.click('[data-testid=ticket-description] .btn:has-text("Cancel")')

  // Plan and goals: the plan moves the ticket to To do, whose sections follow.
  await mcp('kanban_set_plan', { id: 1, plan: '1. Add the route\n2. Write the CSV', goals: [], size: 's', complexity: 'medium' })
  await kp.waitForSelector('[data-testid=ticket-status]:has-text("To do")')
  await kp.waitForSelector('[data-testid=ticket-plan] ol li')
  assert(
    (await sections()).join() === 'Description,-Notes,Briefing conversations,Plan conversations,Goals,Implementation plan',
    'To do: notes folded, briefing, plan and goals open: ' + (await sections()).join(),
  )
  for (const [g, d] of [['The /export route answers', 'curl /export'], ['The CSV has a header', '']]) {
    await kp.fill('[data-testid=ticket-goal-input]', g)
    await kp.fill('[data-testid=ticket-goal-description]', d)
    await page.keyboard.press('Enter')
    await kp.waitForSelector(`[data-testid=ticket-goal]:has-text("${g}")`)
  }
  assert((await kp.$$('[data-testid=ticket-goal]')).length === 2, 'two goals added')
  assert((await kp.textContent('[data-testid=ticket-goal-desc]')) === 'curl /export', 'goal with a description')
  await kp.click('[data-testid=ticket-goal] input[type=checkbox]')
  await kp.waitForSelector('[data-testid=ticket-goal].done')
  assert(true, 'goal checked')

  // Note, linked file, attachment.
  await unfold(page, 'Notes')
  await kp.fill('[data-testid=ticket-note-input]', 'Mind the `;` separator')
  await kp.click('[data-testid=ticket-note-add]')
  await kp.waitForSelector('[data-testid=ticket-note]:has-text("separator")')
  assert(true, 'note added')

  // Claude Code writes through the MCP endpoint of the pod: the window follows, author Claude.
  const note = await mcp('kanban_add_note', { id: 1, text: 'Checked by Claude' })
  assert(note.result && !note.result.isError, 'note through MCP')
  await kp.waitForSelector('[data-testid=ticket-note]:has-text("Checked by Claude")')
  assert((await kp.textContent('[data-testid=ticket-note]:has-text("Checked by Claude") .tk-note-head')).includes('Claude'), 'a note of Claude is shown as written by Claude')
  // A file link of Claude Code opens the file in the window of the project.
  const opened = await fetch(`${process.env.E2E_URL}/open?path=${encodeURIComponent(WS + '/demo/notes.txt')}&line=1`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.E2E_TOKEN },
  }).then((r) => r.json())
  assert(opened.opened, 'file link sent to the window')
  await kp.waitForSelector('.pane .tab.active:has-text("notes.txt")')
  assert(true, 'file link opened in the editor')
  await kp.click('.pane .tab:has-text("#1")')
  await kp.waitForSelector('[data-testid=ticket-view]')
  // The other actions in "More actions"; Claude Code: a terminal of the IDE runs claude with
  // the prompt of the endpoint.
  await kp.click('[data-testid=ticket-more]')
  assert(await kp.isVisible(':is(.ctx-menu, .ide-menu) button:has-text("Back to “New”")'), 'To do: Back to New in More actions')
  await kp.click(':is(.ctx-menu, .ide-menu) button:has-text("Redo the plan with Claude Code (Opus)")')
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('fake claude: --model opus /mcp__web-ide__plan 1'))
  assert(true, 'Claude Code started on the ticket in a terminal')
  await kp.click('[data-testid=ticket-file-add]')
  await kp.waitForSelector('.pick-input')
  await page.keyboard.type('main.go')
  await page.waitForFunction(() => document.querySelector('.pick-item.selected')?.textContent.includes('main.go'))
  await page.keyboard.press('Enter')
  await kp.waitForSelector('.tk-side .tk-row:has-text("src/main.go")')
  assert(true, 'file linked')
  await kp.setInputFiles('[data-testid=ticket-attach]', { name: 'capture.txt', mimeType: 'text/plain', buffer: Buffer.from('bonjour') })
  await kp.waitForSelector('.tk-side .tk-row:has-text("capture.txt")')
  assert(true, 'attachment added')

  // Two columns in a wide pane, one in a narrow one.
  const sideBelow = async () =>
    (await kp.frameOf('.tk-side')).evaluate(() => document.querySelector('.tk-side').getBoundingClientRect().top >= document.querySelector('.tk-main').getBoundingClientRect().bottom)
  assert(!(await sideBelow()), 'wide pane: side column beside the main one')
  await page.setViewportSize({ width: 800, height: 900 })
  await (await kp.frameOf('.tk-side')).waitForFunction(() => document.querySelector('.tk-side').getBoundingClientRect().top >= document.querySelector('.tk-main').getBoundingClientRect().bottom)
  assert(await (await kp.frameOf('.tk-main')).evaluate(() => document.querySelector('.tk-main').getBoundingClientRect().width > 300), 'narrow pane: one full-width column')
  await page.setViewportSize({ width: 1440, height: 900 })
  await (await kp.frameOf('.tk-side')).waitForFunction(() => document.querySelector('.tk-side').getBoundingClientRect().top < document.querySelector('.tk-main').getBoundingClientRect().bottom)

  // A second window follows the changes.
  const page2 = await ctx.newPage()
  await page2.goto(page.url())
  await inFrames(page2).waitForSelector('[data-testid=ticket-view]')

  // Workflow.
  await kp.click('[data-testid=ticket-start]')
  await kp.waitForSelector('[data-testid=ticket-status]:has-text("In progress")')
  assert(
    (await kp.isVisible('.tk-meta-row span.badge:has-text("priority")')) && (await kp.isVisible('span[data-testid=ticket-size]')) && !(await kp.$('.tk-meta-row select:not([data-testid=ticket-complexity]):not([data-testid=ticket-milestone]):not([data-testid=ticket-objective])')),
    'In progress: priority and size fixed, shown as badges',
  )
  assert((await kp.textContent('span[data-testid=ticket-complexity]')) === 'Medium complexity', 'In progress: complexity fixed, shown as a badge')
  assert(!(await kp.$('[data-testid=ai-ticket-bar]')), 'Start development starts no conversation')
  assert((await header()).join() === 'Review · Sonnet,Dev session,Send to testing', 'In progress: Review (Sonnet for a medium ticket), Dev session (no session yet) and Send to testing in the header: ' + (await header()).join())
  assert(await kp.isVisible('.tk-meta-row .btn.primary[data-testid=ticket-dev-session]'), 'Dev session is the main action while no development session exists')
  await kp.click('[data-testid=ticket-review-with]')
  assert((await kp.$$eval(':is(.ctx-menu, .ide-menu) button', (l) => l.map((e) => e.textContent.trim()))).join() === 'With Claude Opus,With Claude Sonnet★', 'Review: Claude Opus or Sonnet, Sonnet recommended for a medium ticket')
  await page.keyboard.press('Escape')
  await kp.click('[data-testid=ticket-review]')
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows')].some((e) => e.textContent.includes('fake claude: --model sonnet /mcp__web-ide__review 1')))
  assert(true, 'Review runs Claude Code on the ticket')
  await kp.click('.pane .tab:has-text("#1")')
  await inFrames(page2).waitForSelector('[data-testid=ticket-status]:has-text("In progress")', { timeout: 5000 })
  assert(true, 'the other window follows the status change')
  await kp.click('[data-testid=ticket-to-test]')
  await kp.waitForSelector('[data-testid=ticket-status]:has-text("To test")')
  assert(
    (await sections()).join() === 'How to test,Feedback,Git and changes,|,-Description,-Briefing conversations,-Notes,-Plan conversations,-Implementation plan,-Goals · 1/2,-Development conversations',
    'To test: test, feedback and git first, then the earlier sections folded, no pull request without a branch: ' + (await sections()).join(),
  )
  assert((await header()).join() === 'Add feedback,Review · Sonnet,Validate the ticket', 'To test: Add feedback, Review and Validate the ticket in the header: ' + (await header()).join())
  await kp.click('[data-testid=ticket-feedback]')
  assert(await (await kp.frameOf('[data-testid=ticket-feedback-input]')).evaluate(() => document.activeElement?.dataset.testid === 'ticket-feedback-input'), 'Add feedback focuses the feedback box')
  await kp.selectOption('[data-testid=ticket-feedback-kind]', 'bug')
  await kp.fill('[data-testid=ticket-feedback-input]', 'The file is empty')
  await kp.click('[data-testid=ticket-feedback-add]')
  await kp.waitForSelector('[data-testid=ticket-feedback-item].k-bug:has-text("The file is empty")')
  assert((await kp.textContent('[data-testid=ticket-status]')).includes('To test'), 'a feedback leaves the ticket in To test')
  assert((await header()).join() === 'Add feedback,Review · Sonnet,Fix feedbacks', 'an open feedback: Fix feedbacks instead of Validate: ' + (await header()).join())
  assert(await kp.isVisible('[data-testid=ticket-feedback-item] [data-testid=ticket-feedback-session]'), 'fix session offered for an open feedback')
  // Routing by complexity: a hard feedback is fixed with the most effort, or Claude Opus.
  assert((await kp.textContent('[data-testid=ticket-complexity]')) === 'Medium complexity', 'complexity of the ticket, written with the plan')
  await kp.selectOption('[data-testid=ticket-feedback-item] [data-testid=ticket-feedback-complexity]', 'high')
  await kp.waitForSelector('[data-testid=ticket-feedback-item] [data-testid=ticket-feedback-session]:has-text("Max")')
  await kp.click('[data-testid=ticket-feedback-item] [data-testid=ticket-feedback-session-with]')
  assert(
    (await kp.$$eval(':is(.ctx-menu, .ide-menu) button', (l) => l.map((e) => e.textContent.trim()))).join() ===
      'With the integrated AI (Max)★,With Claude Opus,With the integrated AI,With Claude Sonnet,With the integrated AI (Low),With Claude Haiku',
    'Fix session: each level, the one of the feedback recommended',
  )
  await kp.click(':is(.ctx-menu, .ide-menu) button:has-text("With Claude Opus")')
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows')].some((e) => /fake claude: --model opus \/mcp__web-ide__fix 1 \d+/.test(e.textContent)))
  assert(true, 'a fix session of the feedback with Claude Opus')
  await kp.click('.pane .tab:has-text("#1")')
  await kp.click('[data-testid=ticket-feedback-item] input[type=checkbox]')
  await kp.waitForSelector('[data-testid=ticket-feedback-item].done')
  await kp.waitForSelector('[data-testid=ticket-close]')
  assert(!(await kp.isVisible('[data-testid=ticket-fix-feedbacks]')), 'feedback handled: Validate the ticket is back')
  assert(!(await kp.isVisible('[data-testid=ticket-feedback-session]')), 'no fix session for a handled feedback')
  await kp.click('[data-testid=ticket-close]')
  await kp.waitForSelector('[data-testid=ticket-status]:has-text("Done")')
  assert(true, 'ticket closed')
  assert((await sections()).join() === '-Feedback · 0 open,|,Description,-Notes,-Implementation plan,-Goals · 1/2', 'Done: the sections with content, folded but the description: ' + (await sections()).join())
  await kp.click('.tk-section-toggle:has-text("History")')
  const events = await kp.$$eval('.tk-events li', (l) => l.length)
  assert(events >= 5, `history of the changes (${events})`)

  // Board and panel.
  await kp.click('.pane.active .tab:has-text("Kanban")')
  await kp.waitForSelector('[data-testid=kanban-board]')
  assert(!(await kp.isVisible('[data-testid=ticket-card-1]')), 'closed ticket hidden from the board')
  await kp.click('.kb-toolbar button:has-text("Done and abandoned")')
  await kp.waitForSelector('[data-testid=ticket-card-1]')
  assert(true, 'closed ticket in the done column')
  assert((await kp.textContent('[data-testid=ticket-card-1] [data-testid=card-status]')) === 'Done', 'a closed card is tagged with its status')
  await kp.waitForSelector('[data-testid=ticket-card-1] [data-testid=card-goals]')
  assert(
    (await kp.$$eval('[data-testid=ticket-card-1] [data-testid=card-goals] li', (l) => l.map((e) => (e.classList.contains('done') ? '✓' : '○') + e.textContent.trim()))).join('|') ===
      '✓The /export route answers|○The CSV has a header',
    'the card lists the goals, checked or not',
  )
  assert(!(await kp.isVisible('[data-testid=ticket-card-1] [data-testid=card-time]')), 'no time without a conversation of the assistant')
  await page.screenshot({ path: OUT + '/kanban-board.png' })
  await kp.click('[data-testid=kanban-settings]')
  await (await kp.frameOf('[data-testid=kanban-mcp-command]')).waitForFunction(() => document.querySelector('[data-testid=kanban-mcp-command]')?.value.includes('/mcp --header'))
  assert(true, 'the setup command of Claude Code is in the kanban settings')
  await kp.click(':is(.modal, .ide-modal) button:has-text("Cancel")')
  await kp.click('.rail-left .rail-btn[title="Kanban"]')
  await kp.click('.rail-left .rail-btn[title="Kanban"]')
  await kp.click('[data-testid=kanban-panel] button[title="New ticket"]')
  await kp.fill('[data-testid=kanban-title]', 'Second ticket')
  await kp.click('[data-testid=kanban-create]')
  await page.waitForTimeout(2500)
  await kp.waitForSelector('[data-testid=kanban-panel] [data-testid=ticket-card-2]')
  assert(true, 'new ticket from the panel')
  await kp.waitForSelector('[data-testid=ticket-view] [data-testid=ticket-title]:has-text("Second ticket")')
  await page.screenshot({ path: OUT + '/kanban-ticket.png' })

  // Lineage: a step waits for its parent, a ticket of another lineage waits for it to be
  // merged or done; tickets made through the MCP endpoint.
  const tool = (name, args) =>
    fetch(process.env.E2E_URL + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.E2E_TOKEN },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { cwd: WS + '/demo', ...args } } }),
    }).then((r) => r.json())
  await tool('kanban_create', { title: 'Lineage root' })
  await tool('kanban_create', { title: 'Lineage step', parent: 3 })
  await tool('kanban_create', { title: 'Waits for the root', depends_on: [3] })
  // Sizes for the roadmap below: fixed once the development started.
  for (const [id, size] of [[3, 'xl'], [4, 's'], [5, 'm']]) await tool('kanban_set_plan', { id, plan: 'p', goals: [{ title: 'g' }], size, complexity: 'medium' })
  await kp.click('.pane.active .tab:has-text("Kanban")')
  await kp.waitForSelector('[data-testid=ticket-card-4] [data-testid=card-parent]:has-text("#3")')
  assert((await kp.textContent('[data-testid=ticket-card-4] [data-testid=card-blocked]')).includes('#3'), 'card of a step: parent and blocker badges')
  assert(await kp.isVisible('[data-testid=ticket-card-5] [data-testid=card-blocked]'), 'card of a dependent ticket: blocker badge')
  await kp.click('[data-testid=ticket-card-4]')
  await page.waitForTimeout(3000)
  await kp.waitForSelector('[data-testid=ticket-view] [data-testid=ticket-parent]:has-text("#3")')
  assert((await kp.textContent('[data-testid=ticket-blockers]')).includes('#3: root not started'), 'the blockers of a step are shown')
  assert(await kp.isDisabled('[data-testid=ticket-start]'), 'a blocked ticket cannot start')
  await kp.click('[data-testid=ticket-more]')
  assert(await kp.isVisible(':is(.ctx-menu, .ide-menu) button:has-text("Start anyway…")'), 'the user can start it anyway, from More actions')
  await page.keyboard.press('Escape')
  await kp.click('[data-testid=ticket-parent] .link')
  await kp.waitForSelector('[data-testid=ticket-view] [data-testid=ticket-child]:has-text("Lineage step")')
  assert(true, 'the parent lists its steps')
  await kp.click('[data-testid=ticket-start]')
  await kp.waitForSelector('[data-testid=ticket-status]:has-text("In progress")')
  await kp.click('[data-testid=ticket-to-test]')
  await kp.waitForSelector('[data-testid=ticket-step]')
  assert(!(await kp.isVisible('[data-testid=ticket-close]')), 'a parent is validated after its steps: only Validate the step shown')
  await page.screenshot({ path: OUT + '/kanban-lineage.png' })
  await kp.click('[data-testid=ticket-step]')
  await kp.waitForSelector('[data-testid=ticket-step]', { state: 'detached' })
  await kp.click('[data-testid=ticket-child] .link')
  await kp.waitForSelector('[data-testid=ticket-view] [data-testid=ticket-title]:has-text("Lineage step")')
  await kp.waitForSelector('[data-testid=ticket-blockers]', { state: 'detached' })
  assert(!(await kp.isDisabled('[data-testid=ticket-start]')), 'the step may start once its parent step is validated')
  await page.goto(page.url().replace(/[?#].*$/, '') + '?ticket=5')
  await kp.waitForSelector('[data-testid=ticket-view] [data-testid=ticket-title]:has-text("Waits for the root")')
  assert(await kp.isVisible('[data-testid=ticket-dep].wait'), 'a dependency not merged is waiting')
  await kp.click('[data-testid=ticket-more]')
  await kp.click(':is(.ctx-menu, .ide-menu) button:has-text("Start anyway…")')
  await kp.waitForSelector('[data-testid=ticket-status]:has-text("In progress")')
  await kp.click('.tk-section-toggle:has-text("History")')
  assert((await kp.textContent('.tk-events')).includes('Started despite: #3 (dependency not merged)'), 'a forced start stays in the history')

  // Roadmap: a row per lineage, blocks as wide as their size, what can start stands out.
  const refused = await tool('kanban_update', { id: 3, size: 's' })
  assert(refused.result?.isError && JSON.stringify(refused).includes('fixed once the development started'), 'the size of a ticket in progress is refused')
  await tool('kanban_create', { title: 'Waits for the second ticket', depends_on: [2] })
  await tool('kanban_set_plan', { id: 6, plan: 'p', goals: [{ title: 'g' }], size: 'm', complexity: 'medium' })
  await kp.click('.pane.active .tab:has-text("Kanban")')
  await kp.click('[data-testid=kanban-view-roadmap]')
  await kp.waitForSelector('[data-testid=roadmap] [data-testid=roadmap-block-6]')
  const box = async (id) => (await kp.$(`[data-testid=roadmap-block-${id}]`)).boundingBox()
  const [b3, b4] = [await box(3), await box(4)]
  assert(Math.abs(b3.y - b4.y) < 2 && b4.x > b3.x, 'a step follows its parent on the same row')
  assert(b3.width > 4 * b4.width, `widths follow the sizes (XL ${b3.width}, S ${b4.width})`)
  const state = (id) => kp.getAttribute(`[data-testid=roadmap-block-${id}]`, 'data-state')
  assert((await state(4)) === 'ready' && (await state(6)) === 'blocked' && (await state(2)) === 'new' && (await state(5)) === 'active', 'ready, blocked, new and active blocks')
  const [b2, b5, b6] = [await box(2), await box(5), await box(6)]
  assert(Math.round(b5.y - b3.y) === 40 && Math.round(b6.y - b2.y) === 40, 'a lineage waiting for another one comes right below it')
  assert(Math.round(b2.y - b5.y) === 56, 'a gap between two groups of linked lineages')
  await tool('kanban_create', { title: 'Lone one' })
  await tool('kanban_create', { title: 'Lone two' })
  await kp.waitForSelector('[data-testid=roadmap-block-8]')
  assert(Math.round((await box(8)).y - (await box(7)).y) === 40, 'no gap between two lone lineages')
  assert(!(await kp.$('[data-testid=roadmap-block-1]')), 'a closed lineage is not on the roadmap')
  assert((await kp.$$('[data-testid=roadmap-arrow]')).length === 2, 'arrows for the dependencies')
  await kp.focus('[data-testid=roadmap-block-3]')
  await page.keyboard.press('ArrowRight')
  assert(await (await kp.frameOf('[data-testid=roadmap-block-4]')).evaluate(() => document.activeElement?.dataset.testid === 'roadmap-block-4'), 'arrow keys move between blocks')
  await page.screenshot({ path: OUT + '/kanban-roadmap.png' })
  await page.keyboard.press('Enter')
  await kp.waitForSelector('[data-testid=ticket-view] [data-testid=ticket-title]:has-text("Lineage step")')
  assert((await kp.$eval('[data-testid=ticket-size]', (e) => e.value)) === 's', 'a block opens its ticket, with its size')
  await kp.click('.pane.active .tab:has-text("Kanban")')
  await kp.waitForSelector('[data-testid=roadmap]')
  assert(true, 'the roadmap view is remembered')
  await kp.click('[data-testid=kanban-view-board]')
  await kp.waitForSelector('.kb-col')

  // Work done outside the flow: the user sets any status, New → Done, with a reason.
  await page.goto(page.url().replace(/[?#].*$/, '') + '?ticket=8')
  await kp.waitForSelector('[data-testid=ticket-view] [data-testid=ticket-title]:has-text("Lone two")')
  await kp.click('[data-testid=ticket-more]')
  await kp.click(':is(.ctx-menu, .ide-menu) button:has-text("Change the status…")')
  await kp.waitForSelector('.pick-input')
  await page.keyboard.type('Done')
  await page.waitForFunction(() => document.querySelector('.pick-item.selected')?.textContent.includes('Done'))
  await page.keyboard.press('Enter')
  await kp.fill('.modal-small input', 'done on main')
  await page.keyboard.press('Enter')
  await kp.waitForSelector('[data-testid=ticket-status]:has-text("Done")')
  await kp.click('.tk-section-toggle:has-text("History")')
  assert((await kp.textContent('.tk-events')).includes('done on main'), 'a New ticket set to Done from More actions, the reason in the history')

  // A ticket link of Claude Code: /project/<id>?ticket=<n> opens its tab.
  await page.goto(page.url().replace(/[?#].*$/, '') + '?ticket=1')
  await kp.waitForSelector('[data-testid=ticket-view] [data-testid=ticket-title]:has-text("CSV export")')
  assert(!page.url().includes('ticket='), 'a ticket link opens the ticket, then leaves the address clean')
  await page2.close()
})
