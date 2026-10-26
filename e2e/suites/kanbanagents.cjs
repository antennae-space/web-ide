// Kanban and the Agents tool: with Claude Code as the development agent (kanban settings),
// Start development opens one ACP session per ticket in its worktree, with the briefing as
// its first prompt and the MCP server of the IDE (the fake agent of e2e/bin calls kanban_get
// through it); the ticket opens its session; abandoning the ticket ends it.
const fs = require('fs')
const { execSync } = require('child_process')
const { run, openProject, assert, mcp, WS, OUT, installOfficial, acceptConfirms, inFrames } = require('../common.cjs')

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
  await kp.click('.rail-left .rail-btn[title="Kanban"]')
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
  const prompt = await kp.textContent('[data-testid=agent-user]')
  assert(prompt.includes('You **develop** this ticket on the branch ticket/1-data-export') && prompt.includes('Develop ticket #1'), 'first prompt: the role, the ticket and the message')
  await page.screenshot({ path: OUT + '/kanban-agent-session.png' })

  // The session is the development of the ticket: kanban_get tells it.
  const got = await mcp('kanban_get', { id: 1 })
  assert(got.result.content[0].text.includes('## Agent session'), 'kanban_get points to the session')

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
