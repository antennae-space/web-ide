// Kanban and the Agents tool: with Claude Code as the development agent (kanban settings),
// Start development opens one ACP session per ticket in its worktree, with the briefing as
// its first prompt and the MCP server of the IDE (the fake agent of e2e/bin calls kanban_get
// through it); the ticket opens its session; abandoning the ticket ends it.
const fs = require('fs')
const { execSync } = require('child_process')
const { run, openProject, assert, mcp, mcpToken, WS, OUT, installOfficial, acceptConfirms, inFrames } = require('../common.cjs')

const repo = WS + '/demo'
const env = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@x' }
const git = (cmd, cwd = repo) => execSync(`git ${cmd}`, { cwd, env, encoding: 'utf8' }).trim()
git('init -q -b main')
git('add -A')
git('commit -q -m "initial state"')

const tab = '[data-testid=agent-tab]'

run(async ({ page }) => {
  // The views of the Kanban are frames of the page (#158).
  const kp = inFrames(page)
  // The Kanban is an external official plugin (#158): its release, or E2E_PLUGIN_KANBAN.
  await installOfficial('kanban')
  page.on('dialog', (d) => d.accept())
  acceptConfirms(page)
  await openProject(page)

  // Kanban settings: Claude Code develops the tickets.
  await kp.click('.rail-left .rail-btn[title^="Kanban"]')
  await kp.click('[data-testid=kanban-open-board]')
  await kp.click('[data-testid=kanban-settings]')
  await kp.waitForSelector('[data-testid=kanban-dev-agent] option[value=claude]', { state: 'attached' })
  await kp.selectOption('[data-testid=kanban-dev-agent]', 'claude')
  await kp.click('[data-testid=kanban-settings-save]')

  await kp.click('[data-testid=kanban-new]')
  await kp.fill('[data-testid=kanban-title]', 'Data export')
  await kp.click('[data-testid=kanban-create]')
  await kp.waitForSelector('[data-testid=ticket-view]')
  await mcp('kanban_set_plan', { id: 1, plan: 'Write export.txt', goals: [{ title: 'export.txt exists' }], size: 's', complexity: 'medium' })
  await kp.waitForSelector('[data-testid=ticket-status]:has-text("To do")')

  // Start: the worktree; Dev session then opens the session of the ticket in the Agents tool.
  await kp.click('[data-testid=ticket-start]')
  await kp.waitForSelector('[data-testid=worktree-banner]:has-text("Ticket #1")', { timeout: 15000 })
  await kp.click('.pane .tab:has-text("#1")')
  await kp.click('[data-testid=ticket-dev-session]')
  await kp.waitForSelector(`${tab} .tab-title:has-text("#1 Data export")`, { timeout: 15000 })
  await kp.waitForSelector(`${tab}[data-state=ready] >> nth=0`, { timeout: 15000 })
  const answer = await kp.waitForSelector('[data-testid=agent-message]:has-text("Briefing received")', { timeout: 15000 })
  const text = await answer.textContent()
  assert(text.includes('Briefing received (ticket #1). MCP web-ide:') && text.includes('Data export'), 'briefing received, kanban_get through the MCP server of the IDE: ' + text)
  const cwd = repo + '/.ide/worktrees/1-data-export'
  const worktreeID = JSON.parse(fs.readFileSync(process.env.E2E_DATA + '/projects.json', 'utf8')).find((p) => p.path === cwd).id
  const managed = fs.readFileSync(process.env.E2E_DATA + '/mcp-managed/' + worktreeID, 'utf8')
  const mainDenied = await mcp('list_commands', { cwd: repo }, managed)
  assert(mainDenied.result.isError && mainDenied.result.content[0].text.includes('not granted'), 'the managed bearer cannot act in the main project')
  const unrelated = await mcp('kanban_create', { title: 'An unrelated ticket' })
  assert(!unrelated.result.isError, 'the Developer can create another ticket in the main project')
  const ticketDenied = await mcp('kanban_get', { cwd, id: 2 }, managed)
  assert(ticketDenied.result.isError && ticketDenied.result.content[0].text.includes('outside the MCP worktree'), 'the managed bearer cannot read another lineage')
  const lineage = await mcp('kanban_create', { title: 'A step of this ticket', parent: 1 })
  assert(!lineage.result.isError, 'the main project Developer can create a step in the worktree lineage')
  const step = await mcp('kanban_get', { cwd, id: 3 }, managed)
  assert(!step.result.isError && step.result.content[0].text.includes('A step of this ticket'), 'the managed bearer can read a step in its lineage')

  const prompt = await kp.textContent('[data-testid=agent-user]')
  assert(prompt.includes('You **develop** this ticket on the branch ticket/1-data-export') && prompt.includes('Develop ticket #1'), 'first prompt: the role, the ticket and the message')
  assert(prompt.includes('# How you work and write') && prompt.includes('one action and one expected result each'), 'first prompt: the rules of every AI (#228)')
  await page.screenshot({ path: OUT + '/kanban-agent-session.png' })

  // The session is the development of the ticket: kanban_get tells it.
  const got = await mcp('kanban_get', { id: 1 })
  assert(got.result.content[0].text.includes('## Agent session'), 'kanban_get points to the session')

  // The MCP tools of a Supervisor on the agent sessions (#285): the Developer profile is
  // refused; the Supervisor reads the session the UI opened, sends it a prompt, answers its
  // permission question in the IDE, starts a step of the lineage in the same worktree, and
  // stops it.
  const say = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r)
  const sup = mcpToken('supervisor')
  const devDenied = await mcp('agent_list', { cwd }, mcpToken())
  assert(devDenied.result.isError && say(devDenied).includes('unavailable'), 'the agent tools are for the Supervisor profile: ' + say(devDenied))
  const providers = await mcp('agent_providers', { cwd }, sup)
  assert(!providers.result.isError && say(providers).includes('- claude (Claude Code): installed'), 'agent_providers: ' + say(providers))
  const listed = say(await mcp('agent_list', { cwd, ticket: 1 }, sup))
  const sid = listed.match(/id (\S+) /)[1]
  assert(listed.includes('ticket #1') && listed.includes('model opus') && listed.includes('Claude Code'), 'agent_list: ' + listed)
  const read = say(await mcp('agent_read', { cwd, session: sid }, sup))
  assert(read.includes('Briefing received') && read.includes('ticket #1'), 'agent_read: ' + read)
  const sent = say(await mcp('agent_send', { cwd, session: sid, message: 'zzz supervisor note' }, sup))
  assert(sent.includes('Message sent'), 'agent_send: ' + sent)
  await kp.waitForSelector('[data-testid=agent-user]:has-text("zzz supervisor note")', { timeout: 15000 })

  // While a turn runs, a second development of the ticket is refused; the agent asks before
  // its edit, and the permission is answered in the thread of the session.
  const asked = await mcp('agent_send', { cwd, session: sid, message: 'permission later' }, sup)
  assert(!asked.result.isError, 'agent_send a permission: ' + say(asked))
  const busy = await mcp('agent_start', { cwd, id: 1, provider: 'claude', model: 'opus' }, sup)
  assert(busy.result.isError && say(busy).includes('already has an active development (session ' + sid), 'one development per ticket: ' + say(busy))
  await kp.waitForSelector('[data-testid=agent-permission][data-outcome=""]', { timeout: 15000 })
  await kp.click('[data-testid=agent-permission][data-outcome=""] [data-testid=agent-option-allow-once]')
  await kp.waitForSelector('[data-testid=agent-message]:has-text("Edited.")', { timeout: 15000 })

  // A step of the lineage runs in the worktree of its root; the model it asks is applied
  // before its first prompt, and a stop cancels its turn. The session starts in the list of the
  // project's sessions, where the IDE opens its tab.
  const stepStart = say(await mcp('agent_start', { cwd, id: 3, provider: 'claude', model: 'sonnet' }, sup))
  const stepID = stepStart.match(/Session (\S+) of ticket #3/)[1]
  assert(stepStart.includes('Model sonnet, applied before the first prompt') && stepStart.includes('Its first prompt is the ticket briefing'), 'agent_start on the step: ' + stepStart)
  await kp.click('[data-testid=agent-sessions-open]')
  const row = '[data-testid=agent-session-row]:has-text("#3 A step of this ticket")'
  await kp.waitForSelector(row, { timeout: 15000 })
  assert((await kp.textContent(row)).includes('Claude Code'), 'the session in the list: ' + (await kp.textContent(row)))
  await kp.waitForSelector(`${row}[data-state=ready]`, { timeout: 15000 })
  await kp.click(`${row} .agent-session-open`)
  await kp.waitForSelector(`${tab} .tab-title:has-text("#3 A step of this ticket")`, { timeout: 15000 })
  await kp.waitForSelector('[data-testid=agent-message]:has-text("Briefing received (ticket #3)")', { timeout: 15000 })
  const stopped = say(await mcp('agent_stop', { cwd, session: stepID }, sup))
  assert(stopped.includes('cancelled'), 'agent_stop: ' + stopped)
  await kp.waitForSelector(`${tab}[data-state=ready]:has-text("#3 A step of this ticket")`, { timeout: 15000 })

  // A call refused by the scope starts nothing: the main project has no session.
  const wrong = await mcp('agent_start', { cwd: repo, id: 1, provider: 'claude' }, sup)
  assert(wrong.result.isError && say(wrong).includes('cwd must be the worktree of ticket #1'), 'cwd outside the worktree: ' + say(wrong))
  assert(say(await mcp('agent_list', { cwd: repo }, sup)).includes('No agent session in this project'), 'a refused call leaves no session')

  // Back on the main folder, the ticket opens its session.
  await kp.click('[data-testid=branch-selector]')
  await kp.click('.pick-item:has-text("main folder")')
  await kp.waitForSelector('[data-testid=branch-selector]:not(:has([data-testid=worktree-banner]))')
  await kp.click('.tab:has-text("#1")')
  await kp.waitForSelector('[data-testid=ticket-agent-session]:has-text("Claude Code")')
  assert(await kp.isVisible('.tk-section:has-text("Development conversations") :text("No linked conversation.")'), 'no conversation of the assistant')
  await kp.click('[data-testid=ticket-agent-open]')
  await kp.waitForSelector('[data-testid=worktree-banner]:has-text("Ticket #1")', { timeout: 15000 })
  await kp.waitForSelector(`${tab}.active .tab-title:has-text("#1 Data export")`)

  // Abandoning the ticket removes its worktree and ends its session.
  await kp.click('.tab:has-text("#1")')
  await kp.click('[data-testid=ticket-more]')
  await kp.click(':is(.ctx-menu, .ide-menu) button:has-text("Abandon the ticket")')
  await kp.click('.modal-small button[type=submit]')

  await kp.waitForSelector('[data-testid=ticket-status]:has-text("Abandoned")', { timeout: 15000 })
  const left = fs.readdirSync(process.env.E2E_DATA + '/agents').filter((d) => d.endsWith('-t1'))
  assert(left.length === 0, 'the sessions of the worktree are removed: ' + left)
})
