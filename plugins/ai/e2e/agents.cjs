// Agents tool: ACP sessions with the fake agent of e2e/bin (claude-agent-acp): opened from
// the launcher, a prompt streams thought, plan, message and an edit with its diff; a
// permission card; the follow mode opens the file of an edit; the composer (/ and @ completion, image and file as blocks, history, queue);
// a config option; Stop; the agent killed is restarted and its session
// loaded; the tabs are those of the desk (#199): closing one hides the session, another desk
// shows none, Other sessions opens it again, Stop ends it; the thread follows its end. Work time and cost: on the tab, the project, and
// the ticket of a session run in its worktree. The daily quota of a Claude subscription (a fake
// usage endpoint) in the bar.
const fs = require('fs')
const http = require('http')
const path = require('path')
const { execSync } = require('child_process')
const { run, openProject, assert, mcp, OUT, WS, installOfficial, inFrames } = require('../../../e2e/common.cjs')

const tab = '[data-testid=agent-tab]'
const state = (page) => page.getAttribute(tab, 'data-state')
const waitState = (page, s) => page.waitForSelector(`${tab}[data-state=${s}]`, { timeout: 15000 })

const box = '[data-testid=agent-input] .ed-content'
const draft = (page) => page.$eval(box, (e) => e.textContent.replace(/\n$/, ''))

/** Types in the message box (an editor: Enter adds a line) and sends with Ctrl+Enter. */
async function prompt(page, text) {
  await page.click(box)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text)
  await page.keyboard.press('Control+Enter')
}

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** The usage endpoint of Claude's OAuth (WEBIDE_QUOTA_URL, run.sh) and the token of Claude
 *  Code in the home of the pod: 3.5 days into the week, 80 % of it used (ahead of the pace). */
function fakeQuota() {
  const home = path.join(process.env.E2E_TMP, 'home', '.claude')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'e2e-token', subscriptionType: 'max' } }))
  const at = (h) => new Date(Date.now() + h * 3600e3).toISOString()
  const srv = http.createServer((req, res) => {
    const ok = req.headers.authorization === 'Bearer e2e-token' && req.headers['anthropic-beta'] === 'oauth-2025-04-20'
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ five_hour: { utilization: 30, resets_at: at(2) }, seven_day: { utilization: 80, resets_at: at(84) }, seven_day_opus: null }))
  })
  srv.listen(Number(process.env.E2E_QUOTA_PORT), '127.0.0.1')
  srv.unref()
}

run(async ({ page }) => {
  fakeQuota()
  // The Kanban is an external official plugin (#158).
  await installOfficial('kanban')
  await openProject(page)
  await page.click('.rail-btn[data-id=agents]')
  await page.waitForSelector('[data-testid=agents-launcher] [data-testid=agent-card-claude]')
  const card = await page.textContent('[data-testid=agent-card-claude]')
  assert(card.includes('Claude Code') && card.includes('Installed'), 'the fake Claude adapter is found in the PATH: ' + card)

  // Open a session: a tab, starting then ready.
  await page.click('[data-testid=agent-card-claude] button:has-text("Open")')
  await page.waitForSelector(tab)
  await waitState(page, 'ready')
  assert((await page.textContent(`${tab} .tab-title`)) === 'Claude Code', 'tab named after the agent')

  // A prompt: the turn streams, then the tab is ready again.
  await prompt(page, 'hello')
  await page.waitForSelector('[data-testid=agent-user]:has-text("hello")')
  await waitState(page, 'ready')
  await page.waitForSelector('[data-testid=agent-message] strong:has-text("fake agent")')
  assert((await page.textContent('[data-testid=agent-message]')).includes('Hello from the fake agent.'), 'chunks joined in one message')
  assert(await page.isVisible('[data-testid=agent-thought]'), 'thought shown')
  const plan = await page.textContent('[data-testid=agent-plan]')
  assert(plan.includes('Say hello') && plan.includes('Edit the file'), 'plan shown: ' + plan)
  const diff = await page.$$eval('[data-testid=agent-diff] .ai-diff > div', (l) => l.map((d) => d.className + ':' + d.textContent))
  assert(diff.includes('del:- hi') && diff.includes('add:+ hello') && diff.includes(':  there'), 'edit with its diff: ' + JSON.stringify(diff))
  await page.waitForFunction(() => document.querySelector('[data-testid=agent-tab] .tab-title')?.textContent === 'Fake session')
  assert((await page.getAttribute('[data-testid=agent-usage]', 'title')).includes('1.2k / 200k'), 'context usage shown on the ring')
  // The popover of the ring: the context and /compact of the agent; the time and cost are in the bar.
  await page.click('[data-testid=agent-usage]')
  const ctx = await page.textContent('[data-testid=agent-context]')
  assert(ctx.includes('1.2k') && ctx.includes('200k'), 'context in the popover: ' + ctx)
  assert(!(await page.$('[data-testid=agent-context-stats]')), 'no time or cost in the popover')
  assert(await page.isVisible('[data-testid=agent-compact]'), 'Compact now: the agent offers /compact')
  await page.keyboard.press('Escape')
  // Time and cost of the turn on the tab (the fake runs on a plan: an API equivalent).
  await page.waitForFunction(() => /Cost: \$0\.\d+ \(API equivalent\)/.test(document.querySelector('[data-testid=agent-tab]')?.title ?? ''))
  assert(/Work: \d+ s/.test(await page.getAttribute(tab, 'title')), 'work time on the tab')
  // The bar on top of the message box (#219): work time · cost, the details in its tooltip.
  await page.waitForSelector('[data-testid=agent-topbar] [data-testid=agent-cost]')
  const bar = (await page.textContent('[data-testid=agent-gentime]')).replace(/\s+/g, ' ').trim()
  assert(/^\d+ s ?· \$0\.\d+$/.test(bar), 'work time and cost in the bar: ' + bar)
  const barTip = await page.getAttribute('[data-testid=agent-gentime]', 'title')
  assert(/1 turns?, /.test(barTip) && barTip.includes('(API equivalent)'), 'the tooltip of the bar details the turns and the API equivalent: ' + barTip)
  assert(!(await page.$('[data-testid=agent-topbar] [data-testid=ai-ticket]')), 'no ticket in the bar outside a ticket worktree')
  // The daily quota of the subscription (Claude Code runs on it): ahead of the pace, red; the
  // panel is narrow (300 px): the day only. A click opens the card of the windows.
  await page.waitForSelector('[data-testid=agent-topbar] [data-testid=ai-quota][data-source=oauth] [data-testid=ai-quota-day].q-over')
  const day = (await page.textContent('[data-testid=ai-quota-day]')).trim()
  assert(/^-\d+%$/.test(day) && !(await page.$('[data-testid=ai-quota-5h]')), 'the rest of the day, negative: ' + day)
  await page.click('[data-testid=agent-topbar] [data-testid=ai-quota]')
  const qCard = await page.textContent('[data-testid=ai-quota-card]')
  assert(qCard.includes('Claude Max subscription') && qCard.includes("Today's share is used up"), 'the card: the plan, the day: ' + qCard)
  const five = await page.textContent('[data-testid=ai-quota-five]')
  assert(five.includes('30% used') && /Reset in 1 h 5\d|Reset in 2 h 00/.test(five), 'the 5 hours, their reset: ' + five)
  const week = await page.textContent('[data-testid=ai-quota-week]')
  assert(week.includes('80% used') && /Pace 50%: 30 points ahead of it/.test(week), 'the week, its pace: ' + week)
  assert(await page.isVisible('[data-testid=ai-quota-week] .ai-q-bar i'), 'the pace marked on the gauge of the week')
  const qBox = await page.$eval('[data-testid=ai-quota-card]', (e) => e.getBoundingClientRect().toJSON())
  assert(qBox.left >= 0 && qBox.right <= (await page.evaluate(() => innerWidth)), 'the card inside the window: ' + JSON.stringify(qBox))
  await page.waitForTimeout(300)
  await page.screenshot({ path: OUT + '/agents-quota.png' })
  await page.keyboard.press('Escape')
  await page.screenshot({ path: OUT + '/agents-turn.png' })

  // A permission: a card in the thread, the tab waits for the user.
  await prompt(page, 'permission please')
  await page.waitForSelector('[data-testid=agent-permission][data-outcome=""]')
  assert((await state(page)) === 'asking', 'tab asking')
  assert((await page.textContent('[data-testid=agent-permission]')).includes('Allow: Edit hello.txt?'), 'permission titled by its tool call')
  await page.click('[data-testid=agent-option-allow-once]')
  await page.waitForSelector('[data-testid=agent-permission][data-outcome=allow-once]')
  await page.waitForSelector('[data-testid=agent-message]:has-text("Edited.")')
  await waitState(page, 'ready')

  // Follow mode: off by default (the edit of hello.txt opened nothing), on from the eye of the
  // composer bar: the file of an edit done opens in the editor (its relative path made absolute).
  const editorTabs = () => page.$$eval('.pane .tab', (l) => l.map((t) => t.textContent))
  assert(!(await editorTabs()).some((t) => t.includes('hello.txt')), 'no file opened without the follow mode')
  assert((await page.getAttribute('[data-testid=agent-follow]', 'aria-pressed')) === 'false', 'follow mode off')
  await page.click('[data-testid=agent-follow]')
  await page.waitForSelector('[data-testid=agent-follow][aria-pressed=true]')
  await prompt(page, 'follow me')
  await page.waitForSelector('[data-testid=agent-message]:has-text("Wrote follow.txt.")')
  await page.waitForFunction(() => document.querySelector('.pane.active .tab.active')?.textContent.includes('follow.txt'))
  await page.waitForFunction(() => document.querySelector('.pane.active .ed-content')?.textContent.includes('followed'))
  await page.click(`${tab}`, { button: 'right' })
  await page.waitForSelector('.ctx-menu .ctx-item:has-text("Follow the edits") .ctx-check.on')
  await page.keyboard.press('Escape')
  await page.click('[data-testid=agent-follow]')
  await page.waitForSelector('[data-testid=agent-follow][aria-pressed=false]')
  await waitState(page, 'ready')

  // The composer: /commands of the agent, @paths of the project.
  await page.click(box)
  await page.keyboard.type('/rev')
  await page.waitForSelector('[data-testid=ai-complete] .ai-complete-label:has-text("/review")')
  assert((await page.textContent('[data-testid=ai-complete]')).includes('Review the changes'), 'the commands the agent announces, with their description')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type('see @go.m')
  await page.waitForSelector('[data-testid=ai-complete] .ai-complete-label:has-text("go.mod")')
  await page.keyboard.press('Enter')
  assert((await draft(page)).trimEnd() === 'see @go.mod', '@ completes a file of the project: ' + (await draft(page)))

  // A multi-line prompt with an image and a file: text, resource link and image blocks.
  await page.setInputFiles('[data-testid=agent-composer] input[type=file]', { name: 'dot.png', mimeType: 'image/png', buffer: PNG })
  await page.waitForSelector('[data-testid=agent-atts] .ai-att[data-kind=image]')
  await prompt(page, 'blocks: look at @go.mod\nsecond line')
  await page.waitForSelector('[data-testid=agent-message]:has-text("blocks: text,resource_link:go.mod,image:image/png")')
  const sent = await page.$$eval('[data-testid=agent-user]', (l) => l[l.length - 1].textContent)
  assert(sent.includes('look at @go.mod') && sent.includes('second line'), 'multi-line prompt kept: ' + sent)
  await page.waitForSelector('[data-testid=agent-user] [data-testid=agent-user-att] img')
  assert(!(await page.$('[data-testid=agent-atts]')), 'attachments cleared once sent')
  await waitState(page, 'ready')

  // The switch of the session (#220): the image sent is page 1 of its board, in place of the
  // thread in this narrow tool; Reuse draws on a copy joined to the next prompt; Stats shows
  // the session; Chat brings the thread back.
  const sw = (id) => `[data-testid=agent-session] [data-testid=${id}]`
  await page.waitForSelector(`${sw('ai-board-toggle')} .ai-board-count:text-is("1")`)
  assert(true, 'the image sent counts on Board')
  await page.click(sw('ai-board-toggle'))
  await page.waitForSelector('[data-testid=agent-session] [data-testid=bd-title]:has-text("Page 1 · dot.png")')
  assert(!(await page.isVisible('[data-testid=agent-thread]')), 'narrow: the board takes the place of the thread')
  await page.screenshot({ path: OUT + '/agents-board.png' })
  await page.click('[data-testid=agent-session] [data-testid=bd-reuse]')
  await page.waitForSelector('[data-testid=doodle] [data-testid=dd-attach]')
  await page.click('[data-testid=doodle] [data-testid=dd-attach]')
  await page.waitForSelector('[data-testid=doodle]', { state: 'detached' })
  await page.click(sw('ai-stats-toggle'))
  await page.waitForSelector('[data-testid=agent-stats-view] [data-testid=agent-stats-session]')
  assert(/Turns/.test(await page.textContent('[data-testid=agent-stats-session]')), 'Stats: the totals of the session')
  await page.waitForSelector('[data-testid=agent-stats-view] [data-testid=agent-stats-project]')
  assert(true, 'Stats: the project over the period, the turns of the open session included')
  await page.screenshot({ path: OUT + '/agents-stats.png' })
  await page.click(sw('ai-view-chat'))
  await page.waitForSelector('[data-testid=agent-thread]', { state: 'visible' })
  await page.waitForSelector('[data-testid=agent-atts] .ai-att[data-kind=doodle]')
  assert(true, 'the copy drawn on the page waits in the message box')
  await page.click('[data-testid=agent-atts] .ai-att[data-kind=doodle] .ai-att-x')
  await page.waitForSelector('[data-testid=agent-atts]', { state: 'detached' })

  // ↑ in the empty box: the prompts sent.
  await page.click(box)
  await page.keyboard.press('ArrowUp')
  assert((await draft(page)).startsWith('blocks: look at @go.mod'), 'history with ↑: ' + (await draft(page)))
  await page.keyboard.press('ArrowDown')
  assert((await draft(page)) === '', 'back to an empty box with ↓')

  // The settings of the agent in the bar of the composer: the mode as the mode button of the
  // assistant (its color), the model as its model button, the effort behind the options.
  const mode = '[data-testid=agent-composer] [data-testid=agent-config-mode]'
  assert((await page.textContent(mode)).trim() === 'Manual', 'the mode button shows the mode')
  assert(await page.$('[data-testid=agent-composer].mode-manual'), 'manual mode: its color')
  await page.click(mode)
  await page.click('[data-testid=agent-config-mode-list] [data-value=bypass]')
  await page.waitForSelector(`${mode}[data-value=bypass]`)
  assert(await page.$('[data-testid=agent-composer].mode-bypass'), 'bypass mode: its color')
  await page.click(box)
  await page.keyboard.press('Shift+Tab')
  await page.waitForSelector(`${mode}[data-value=default]`)
  await page.keyboard.press('Shift+Tab')
  await page.waitForSelector(`${mode}[data-value=plan]`)
  assert(await page.$('[data-testid=agent-composer].mode-plan'), 'Shift+Tab goes to the next mode')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await page.waitForSelector(`${mode}[data-value=bypass]`)
  await page.click('[data-testid=agent-config-model]')
  await page.click('[data-testid=agent-config-model-list] [data-value=sonnet]')
  await page.waitForSelector('[data-testid=agent-config-model][data-value=sonnet]')
  assert((await page.textContent('[data-testid=agent-config-model]')).includes('Sonnet'), 'the model button shows the model')
  await page.click('[data-testid=agent-options]')
  await page.click('[data-testid=agent-config-effort] button:has-text("Low")')
  await page.waitForSelector('[data-testid=agent-config-effort] button.on:has-text("Low")')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: OUT + '/agents-composer.png' })
  // Full screen: the thread hidden, Esc leaves.
  await page.click('[data-testid=agent-full]')
  assert(!(await page.isVisible('[data-testid=agent-thread]')), 'full screen hides the thread')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid=agent-thread]', { state: 'visible' })

  // A thought streams open, with its clock, then folds when the turn ends.
  await prompt(page, 'slow think')
  const live = '[data-testid=agent-thought].live.open'
  await page.waitForSelector(`${live} [data-testid=agent-thought-text]:has-text("tick 3")`)
  assert(await page.isVisible(`${live} .spinner`), 'a live thought has a spinner')
  await page.waitForSelector(`${live} .ai-dur`)
  await page.click('[data-testid=agent-stop]')
  await waitState(page, 'ready')
  await page.waitForSelector('[data-testid=agent-thought]:has-text("tick 3"):not(.live):not(.open)')
  assert(!(await page.isVisible('[data-testid=agent-thought-text]:has-text("tick 3")')), 'the thought folds at the end of the turn')

  // The thread follows its end while the agent writes (an earlier tool call filled in place
  // included); a move up stops following; a prompt sent follows again (#221).
  const thread = '[data-testid=agent-session] .ai-messages'
  const fromEnd = () => page.$eval(thread, (e) => e.scrollHeight - e.scrollTop - e.clientHeight)
  await prompt(page, 'long A')
  await page.waitForSelector('[data-testid=agent-message]:has-text("A done.")')
  await waitState(page, 'ready')
  await page.waitForTimeout(300)
  assert((await fromEnd()) < 5, 'the thread stayed at its end: ' + (await fromEnd()))
  await prompt(page, 'long B')
  await page.waitForSelector('[data-testid=agent-message]:has-text("B line 10")')
  await page.$eval(thread, (e) => e.scrollBy(0, -400))
  const top = await page.$eval(thread, (e) => e.scrollTop)
  await page.waitForSelector('[data-testid=agent-message]:has-text("B done.")')
  await waitState(page, 'ready')
  assert(Math.abs((await page.$eval(thread, (e) => e.scrollTop)) - top) < 5 && (await fromEnd()) > 400, 'scrolled up: the thread stays where the user put it')
  await prompt(page, 'long C')
  await page.waitForSelector('[data-testid=agent-message]:has-text("C done.")')
  await waitState(page, 'ready')
  await page.waitForTimeout(300)
  assert((await fromEnd()) < 5, 'a prompt sent follows the end again: ' + (await fromEnd()))

  // Stop during a turn; a prompt sent meanwhile waits in the queue, then goes.
  await prompt(page, 'slow')
  await page.waitForSelector('[data-testid=agent-message]:has-text("tick 3")')
  assert((await state(page)) === 'busy', 'tab busy')
  await prompt(page, 'queued meanwhile')
  await page.waitForSelector('[data-testid=agent-queue]:has-text("queued meanwhile")')
  await page.click('[data-testid=agent-stop]')
  await page.waitForSelector('[data-testid=agent-notice]:has-text("Stopped.")')
  await page.waitForSelector('[data-testid=agent-user]:has-text("queued meanwhile")')
  await waitState(page, 'ready')
  assert(!(await page.$('[data-testid=agent-queue]')), 'queue sent at the end of the turn')

  // The agent dies: restarted with its session loaded; the thread stays, without the replay.
  const users = await page.$$eval('[data-testid=agent-user]', (l) => l.length)
  await prompt(page, 'crash')
  await page.waitForSelector('[data-testid=agent-notice]:has-text("it is restarted and its session loaded")')
  await waitState(page, 'ready')
  assert(!(await page.isVisible('text=replayed answer')), 'the replay of session/load is not shown')
  await prompt(page, 'hello again')
  await page.waitForSelector('[data-testid=agent-user]:has-text("hello again")')
  await waitState(page, 'ready')
  assert((await page.$$eval('[data-testid=agent-user]', (l) => l.length)) === users + 2, 'thread kept across the restart')

  // A reload gets the thread back from the pod.
  await page.reload()
  await page.waitForSelector('.menubar')
  if (!(await page.isVisible('[data-testid=agent-session]'))) await page.click('.rail-btn[data-id=agents]')
  await page.waitForSelector('[data-testid=agent-user]:has-text("hello again")')

  // Closing the tab hides the session on the desk; the + menu opens it again.
  await page.click(`${tab} .tab-close`)
  await page.waitForSelector('[data-testid=agents-launcher]')
  assert((await page.$$(tab)).length === 0, 'the tab is closed')
  await page.click('[data-testid=agent-new]')
  await page.click('.ctx-menu >> text=Open “Fake session”')
  await page.waitForSelector(`${tab}[data-state=ready]`)
  assert(true, 'a hidden session goes on and opens again from the + menu')

  // Another desk shows none of the sessions of desk 1, and lists them in its + menu.
  await page.click('[data-testid=desk-add]')
  await page.waitForFunction(() => location.pathname.endsWith('/desk/2'))
  if (!(await page.isVisible('.agents-panel'))) await page.click('.rail-btn[data-id=agents]')
  await page.waitForSelector('[data-testid=agents-launcher]')
  assert((await page.$$(tab)).length === 0, 'desk 2 has no tab of the sessions of desk 1')
  await page.click('[data-testid=agent-new]')
  await page.waitForSelector('.ctx-menu >> text=Open “Fake session”')
  await page.keyboard.press('Escape')
  await page.click('[data-testid=desk-1]')
  await page.waitForFunction(() => !location.pathname.includes('/desk/'))
  await page.waitForSelector(tab)

  // Stop ends the session.
  await page.click(tab, { button: 'right' })
  await page.click('.ctx-menu >> text=Stop the session')
  await page.waitForSelector('[data-testid=agents-launcher]')
  assert((await page.$$(tab)).length === 0, 'session stopped')

  // The turns stay counted for the project once the session is closed.
  await page.waitForFunction(() => /\$0\.\d+/.test(document.querySelector('[data-testid=project-agent-stats-value]')?.textContent ?? ''))

  // A session in the worktree of a ticket: its time and cost on the ticket.
  const home = page.url().replace(/[?#].*$/, '')
  // A ticket branch needs a first commit.
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test' }
  execSync('git add -A && git commit -q -m "initial state"', { cwd: WS + '/demo', env })
  await mcp('kanban_create', { title: 'Timed by the agents' })
  const created = await mcp('kanban_list', {})
  const n = Math.max(...[...JSON.stringify(created).matchAll(/#(\d+)/g)].map((m) => +m[1]))
  await mcp('kanban_set_plan', { id: n, plan: 'Do it.', goals: [{ title: 'Done' }], size: 's', complexity: 'low' })
  const started = JSON.stringify(await mcp('kanban_start', { id: n }))
  const wt = started.match(/project\/([\w-]+-t\d+)/)?.[1]
  assert(wt, 'ticket started in a worktree: ' + started.slice(0, 300))
  await page.goto(home.replace(/\/project\/[^/]+$/, '/project/' + wt))
  await page.waitForSelector('.menubar')
  if (!(await page.isVisible('[data-testid=agents-launcher]'))) await page.click('.rail-btn[data-id=agents]')
  await page.click('[data-testid=agent-card-claude] button:has-text("Open")')
  await waitState(page, 'ready')
  await prompt(page, 'hello')
  await page.waitForSelector('[data-testid=agent-user]:has-text("hello")')
  await waitState(page, 'ready')
  // The bar shows the ticket of the worktree and the role on it, the ticket's total in the tooltip.
  await page.waitForSelector(`[data-testid=agent-topbar] [data-testid=ai-ticket]:has-text("#${n}")`)
  assert((await page.textContent('[data-testid=agent-topbar] [data-testid=ai-role]')).trim().length > 0, 'the role on the ticket in the bar')
  await page.waitForFunction((n) => (document.querySelector('[data-testid=agent-gentime]')?.title ?? '').includes(`Ticket #${n}: `), n)
  await page.goto(home + '?ticket=' + n)
  const kp = inFrames(page)
  await kp.waitForSelector('[data-testid=ticket-agent-stats]')
  const badge = await kp.textContent('[data-testid=ticket-agent-stats]')
  assert(/^Agents: \d+ s · \$0\.\d+$/.test(badge), 'time and cost on the ticket: ' + badge)
})
