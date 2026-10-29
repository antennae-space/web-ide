// Orchestrator mode, the default of a new conversation: "what do we work on today?" lists the
// tickets that can start and offers a card (nothing runs before the click; the click starts
// the development); "what did we do yesterday?" reads the history of the kanban; "I have an
// idea" moves the user into a new Briefing conversation where the idea is sent, with a link
// back in the orchestrator thread; Shift+Tab cycles through the four modes (Orchestrator →
// Briefing → Plan → Build). The development
// started from a card is followed by the orchestrator; another conversation is adopted with
// agent_adopt: it announces itself with a note, says who follows it and is nested.
const http = require('http')
const { run, openProject, assert, mcp, OUT, installOfficial, inFrames, acceptConfirms } = require('../../../e2e/common.cjs')

const sse = (res, delta) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
function end(res, reason = 'stop') {
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`)
  res.end('data: [DONE]\n\n')
}
const text = (m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join(' '))
const call = (res, id, name, args) => {
  sse(res, { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  end(res, 'tool_calls')
}
const say = (res, s) => (sse(res, { content: s }), end(res))
const today = () => new Date().toISOString().slice(0, 10)

const outputs = {}
const fake = http.createServer(async (req, res) => {
  if (req.url === '/api/version') return res.writeHead(404).end()
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fake-model', status: { value: 'loaded' } }] }))
  if (req.url.startsWith('/props')) return res.end(JSON.stringify(req.url === '/props' ? { role: 'router' } : { default_generation_settings: { n_ctx: 32768 } }))
  let body = ''
  for await (const c of req) body += c
  const r = JSON.parse(body)
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const sys = text(r.messages[0])
  const last = r.messages[r.messages.length - 1]
  const content = text(last)
  if (sys.includes('**Briefing mode**')) return say(res, "Let's clarify the dark mode.")
  if (!sys.includes('**Orchestrator mode**')) {
    outputs.devSystem = sys
    if (content.includes('You are now followed')) return call(res, 'an', 'agent_note', { title: 'Login page under way', text: 'The form is done.' })
    if (content === 'Break please') {
      res.write(`data: ${JSON.stringify({ error: { message: 'model server crashed' } })}\n\n`)
      return res.end()
    }
    return say(res, 'Developing.')
  }
  outputs.tools = r.tools.map((t) => t.function.name)
  if (content === 'What do we work on today?') return call(res, 'n', 'kanban_next', {})
  if (content.startsWith('Can start now')) {
    outputs.next = content
    return call(res, 'c', 'action_card', { kind: 'start_dev', ticket: 1, label: 'Start #1', reason: 'First in line' })
  }
  if (content === 'What did we do yesterday?') return call(res, 'h', 'kanban_history', { from: today() })
  if (content.startsWith('Tickets that moved')) {
    outputs.history = content
    return say(res, 'Two tickets were planned.')
  }
  if (content === 'Resume the broken one') return call(res, 'lb', 'list_conversations', { query: 'Break' })
  if (last.role === 'tool' && last.tool_call_id === 'lb') {
    outputs.failedLine = content
    return call(res, 'rs', 'agent_resume', { chat: /^- (\w+) "/m.exec(content)[1] })
  }
  if (last.role === 'tool' && last.tool_call_id === 'rs') return say(res, 'Resumed it.')
  if (content === 'Follow the footer') return call(res, 'l', 'list_conversations', { query: 'footer' })
  if (last.role === 'tool' && last.tool_call_id === 'l') return call(res, 'ad', 'agent_adopt', { chat: /^- (\w+) "/m.exec(content)[1] })
  if (last.role === 'tool' && last.tool_call_id === 'ad') return say(res, 'I follow the footer now.')
  if (content.startsWith('I have an idea')) return call(res, 'o', 'open_conversation', { mode: 'briefing', message: 'Idea: a dark mode', send: true })
  if (last.role === 'tool' && last.tool_call_id === 'c') return say(res, 'Click the card to start it.')
  return say(res, 'Done.')
})

run(
  async ({ page }) => {
    page.on('dialog', (d) => d.accept())
    await new Promise((r) => fake.listen(0, '127.0.0.1', r))
    try {
      // The Kanban is an external official plugin (#158).
      await installOfficial('kanban')
      await openProject(page)
      const kp = inFrames(page)
      acceptConfirms(page)
      // Two planned tickets.
      await page.click('.rail-left .rail-btn[title^="Kanban"]')
      for (const [i, title] of ['Login page', 'Dark theme'].entries()) {
        await kp.click('[data-testid=kanban-open-board]')
        await kp.click('[data-testid=kanban-new]')
        await kp.fill('[data-testid=kanban-title]', title)
        await kp.click('[data-testid=kanban-create]')
        await kp.waitForSelector(`[data-testid=ticket-view]:has-text("${title}")`)
        await mcp('kanban_set_plan', { id: i + 1, plan: 'The plan', goals: [], size: 's', complexity: 'medium' })
        await kp.waitForSelector('[data-testid=ticket-status]:has-text("To do")')
      }

      await page.click('.rail-right .rail-btn[title^="Assistant"]')
      await page.click('.ai-empty button:has-text("Add a model server")')
      await page.fill('.ai-servers input[name=url]', `127.0.0.1:${fake.address().port}`)
      await page.click('.ai-servers button:has-text("Add")')
      await page.waitForSelector('.ai-server-row:has-text("127.0.0.1")')
      await page.click('.ai-servers .modal-head button')
      await page.waitForSelector('[data-testid=model-pill]:has-text("fake-model")')
      assert((await page.textContent('.ai-mode')).includes('Orchestrator'), 'a new conversation starts in Orchestrator mode')
      assert(await page.isVisible('.ai-suggestion:has-text("What do we work on today?")'), 'the welcome offers the questions of the day')
      await page.focus('.ai-composer .ed-content')
      const modes = []
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Shift+Tab')
        modes.push((await page.textContent('.ai-mode-label')).trim())
      }
      assert(modes.join(',') === 'Briefing,Plan,Build,Orchestrator', 'Shift+Tab cycles through the modes: ' + modes)

      // 1. What next: a card; nothing runs before the click.
      await page.fill('.ai-composer .ed-content', 'What do we work on today?')
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('.ai-msg.assistant .md:has-text("Click the card to start it.")', { timeout: 20000 })
      assert(outputs.next.includes('#1 [To do] (Normal) Login page') && outputs.next.includes('#2 [To do] (Normal) Dark theme'), 'kanban_next lists the tickets that can start: ' + outputs.next)
      assert(outputs.tools.includes('edit_file') && outputs.tools.includes('open_conversation'), 'the Orchestrator has its tools (file changes in the scratch folder only)')
      assert((await page.textContent('[data-testid=ai-action]')).includes('First in line'), 'the action card with its reason')
      await page.screenshot({ path: OUT + '/orchestrator-card.png' })
      assert(!(await page.isVisible('.ai-msg.assistant .md:has-text("Developing.")')), 'nothing started before the click')
      await page.click('[data-testid=ai-action-run]')
      // Without git, the development goes on in the project folder (confirmed), here.
      await page.waitForSelector('.ai-msg.assistant .md:has-text("Developing.")', { timeout: 20000 })
      assert(true, 'the click started the development of #1')
      await page.waitForSelector('[data-testid=ai-parent]', { timeout: 5000 })
      assert(true, 'the top bar of the development links to the orchestrator that follows it')

      // 2. What did we do: the history of the kanban.
      await page.click('.ai-panel button[title="New conversation"]')
      await page.fill('.ai-composer .ed-content', 'What did we do yesterday?')
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('.ai-msg.assistant .md:has-text("Two tickets were planned.")', { timeout: 20000 })
      assert(outputs.history.includes('Login page') && outputs.history.includes('In progress'), 'kanban_history lists the moves of the period: ' + outputs.history)

      // 3. An idea: a Briefing conversation opens for the user, the idea sent.
      await page.click('.ai-panel button[title="New conversation"]')
      await page.fill('.ai-composer .ed-content', 'I have an idea: a dark mode')
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('.ai-msg.assistant .md:has-text("Let\'s clarify the dark mode.")', { timeout: 20000 })
      assert((await page.textContent('.ai-mode')).includes('Briefing'), 'the view moved to a Briefing conversation')
      assert(await page.isVisible('.ai-msg.user:has-text("Idea: a dark mode")'), 'the idea was sent in it')
      await page.screenshot({ path: OUT + '/orchestrator-briefing.png' })
      if (!(await page.isVisible('[data-testid=ai-sidebar]'))) await page.click('.ai-panel button[title="Conversations of the project"]')
      await page.click('.ai-chat-open:has-text("I have an idea")')
      await page.waitForSelector('[data-testid=ai-opened]')
      assert(true, 'the orchestrator thread keeps a link to the conversation it opened')

      // 4. Adoption: a conversation started by hand becomes a sub-agent of the orchestrator;
      // it announces itself and keeps its own tools.
      await page.click('.ai-panel button[title="New conversation"]')
      await page.focus('.ai-composer .ed-content')
      await page.keyboard.press('Shift+Tab') // Briefing
      await page.keyboard.press('Shift+Tab') // Plan
      await page.keyboard.press('Shift+Tab') // Build
      await page.fill('.ai-composer .ed-content', 'Work on the footer')
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('.ai-msg.assistant .md:has-text("Developing.")', { timeout: 20000 })
      await page.click('.ai-panel button[title="New conversation"]')
      await page.fill('.ai-composer .ed-content', 'Follow the footer')
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('.ai-msg.assistant .md:has-text("I follow the footer now.")', { timeout: 20000 })
      await page.waitForSelector('[data-testid=ai-child]:has-text("footer")', { timeout: 10000 })
      assert(true, 'the adopted conversation shows as a sub-agent card')
      await page.waitForSelector('.ai-row:has-text("Login page under way")', { timeout: 20000 })
      assert(outputs.devSystem.includes('# You are followed by an Orchestrator'), 'the adopted conversation is told to note and report')
      if (!(await page.isVisible('[data-testid=ai-sidebar]'))) await page.click('.ai-panel button[title="Conversations of the project"]')
      await page.waitForSelector('[data-testid=ai-side-active] [data-testid=ai-chat-child]:has-text("footer")', { timeout: 5000 })
      assert((await page.textContent('[data-testid=ai-side-active]')).includes('Follow the footer'), 'the orchestrator conversation with its working child is in Active, the child under it')
      assert(await page.isVisible('[data-testid=ai-side-active] [data-testid=ai-chat-child]:has-text("#1")'), 'an older conversation with a working child comes back to Active with its tree')
      assert((await page.textContent('[data-testid=ai-side-active] .ai-chat-item')).includes('Follow the footer'), 'the most recent active conversation comes first')
      assert(await page.isVisible('[data-testid=ai-side-active] .ai-chat-item:not(.nested):has-text("Follow the footer") .ai-chat-open svg'), 'an Orchestrator conversation keeps its mode icon in the history')
      assert(!(await page.isVisible('[data-testid=ai-side-active] [data-testid=ai-chat-child]:has-text("footer") .ai-chat-open svg')), 'a child in Build mode has no mode icon')
      await page.click('[data-testid=ai-chat-child]:has-text("footer")')
      await page.waitForSelector('[data-testid=ai-parent]', { timeout: 5000 })
      assert((await page.getAttribute('[data-testid=ai-parent] .link', 'title')) === 'Open the parent conversation', 'the top bar of the adopted conversation links to the orchestrator that follows it')

      // 5. A conversation failed on its own: the orchestrator resumes it and adopts it.
      await page.click('.ai-panel button[title="New conversation"]')
      await page.focus('.ai-composer .ed-content')
      await page.keyboard.press('Shift+Tab') // Briefing
      await page.keyboard.press('Shift+Tab') // Plan
      await page.keyboard.press('Shift+Tab') // Build
      await page.fill('.ai-composer .ed-content', 'Break please')
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('[data-testid=ai-dismiss]', { timeout: 20000 })
      await page.click('.ai-panel button[title="New conversation"]')
      await page.fill('.ai-composer .ed-content', 'Resume the broken one')
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('.ai-msg.assistant .md:has-text("Resumed it.")', { timeout: 20000 })
      assert(outputs.failedLine.includes('failed (agent_resume)'), 'list_conversations tells the failed conversation: ' + outputs.failedLine)
      await page.waitForSelector('[data-testid=ai-child]:has-text("Break please")', { timeout: 10000 })
      if (!(await page.isVisible('[data-testid=ai-sidebar]'))) await page.click('.ai-panel button[title="Conversations of the project"]')
      await page.waitForSelector('[data-testid=ai-side-active] [data-testid=ai-chat-child]:has-text("Break please")', { timeout: 10000 })
      assert(!(await page.isVisible('[data-testid=ai-chat-child]:has-text("Break please") [data-testid=ai-dot-failed]')), 'resumed and adopted: under the orchestrator, no longer failed')
    } finally {
      fake.close()
    }
  },
  { orchestrator: true },
)
