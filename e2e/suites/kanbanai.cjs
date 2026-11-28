// Kanban and the assistant: ask_user (questions one at a time, recap, answers sent back),
// kanban_create / kanban_list from any conversation, writing tools only when linked,
// Briefing mode (tickets created and linked to the conversation).
const http = require('http')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { run, openProject, addProjectFolder, mcpToken, mcp, mcpRPC, assert, unfold, OUT, WS, installOfficial, acceptConfirms, inFrames, dropNotes } = require('../common.cjs')

const requests = []
let continueDevelopment
const sse = (res, delta) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
// Each answer lasts a little: the ticket shows the time of the answers.
function end(res, reason = 'stop') {
  setTimeout(() => {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 10 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  }, 30)
}
const text = (m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join(' '))
const calls = (list) => list.map(([id, name, args], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }))
const toolNames = (r) => (r.tools ?? []).map((t) => t.function.name)

const fake = http.createServer(async (req, res) => {
  if (req.url === '/api/version') return res.writeHead(404).end()
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fake-model', status: { value: 'loaded' } }] }))
  if (req.url.startsWith('/props')) return res.end(JSON.stringify(req.url === '/props' ? { role: 'router' } : { default_generation_settings: { n_ctx: 32768 } }))
  let body = ''
  for await (const c of req) body += c
  const r = dropNotes(JSON.parse(body))
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  requests.push(r)
  const msgs = r.messages
  const last = msgs[msgs.length - 1]
  const firstUser = text(msgs.find((m) => m.role === 'user') ?? {})
  if (firstUser === 'Check the ACP fixture') {
    if (last === msgs[1]) {
      sse(res, { tool_calls: calls([['acp-question', 'ask_user', { questions: [{ question: 'Which marker should I check?' }] }]]) })
      return end(res, 'tool_calls')
    }
    if (text(last) === 'Hold this turn') {
      sse(res, { content: 'Partial review.' })
      await new Promise((resolve) => res.once('close', resolve))
      return
    }
    sse(res, { content: 'ACP review finished.' })
    return end(res)
  }
  if (firstUser.includes('“MCP worktree fixture”')) {
    if (last === msgs[1]) {
      await new Promise((resolve) => { continueDevelopment = resolve })
      sse(res, { tool_calls: calls([
        ['wt', 'read_file', { path: 'worktree-marker.txt' }],
        ['outside', 'read_file', { path: '../outside.txt' }],
        ['write', 'write_file', { path: 'worktree-result.txt', content: 'Written by the Assistant' }],
      ]) })
      return end(res, 'tool_calls')
    }
    if (last.tool_call_id === 'write') {
      sse(res, { content: 'Worktree read: ' + text(msgs.find((m) => m.tool_call_id === 'wt')) })
      return end(res)
    }
    if (last.role === 'user' && text(last).includes('Check the output format')) {
      sse(res, { tool_calls: calls([['format', 'ask_user', { questions: [{ question: 'Which format for this ticket?', options: [{ label: 'CSV' }, { label: 'JSON' }] }] }]]) })
      return end(res, 'tool_calls')
    }
    sse(res, { content: 'Development answer: ' + text(last) })
    return end(res)
  }
  if (firstUser === 'Supervisor conversation') {
    if (last.role === 'user') {
      sse(res, { tool_calls: calls([['mcp-command', 'bash', { command: 'touch mcp-forbidden' }]]) })
      return end(res, 'tool_calls')
    }
    sse(res, { content: 'Supervisor analysis finished.' })
    return end(res)
  }
  if (firstUser === 'MCP first message') {
    sse(res, { content: 'MCP received ' + text(last) })
    return end(res)
  }
  if (firstUser.startsWith('Write the implementation plan')) {
    if (last.role === 'user')
      return (
        sse(res, {
          tool_calls: calls([
            ['s1', 'kanban_set_plan', { plan: '## Approach\n1. Add the route\n2. Test', goals: [{ title: 'The route answers', description: 'curl /export gives 200' }, 'The tests pass'], size: 'l', complexity: 'low' }],
          ]),
        }),
        end(res, 'tool_calls')
      )
    sse(res, { content: 'Plan saved.' })
    return end(res)
  }
  if (firstUser.startsWith('Brief:')) {
    // Claude Code writes in the conversation (MCP kanban_reply), then answers its question.
    if (last.role === 'user' && String(last.content).includes('Claude Code here'))
      return sse(res, { tool_calls: calls([['c0', 'ask_user', { questions: [{ question: 'CSV or JSON?', options: [{ label: 'CSV' }, { label: 'JSON' }] }] }]]) }), end(res, 'tool_calls')
    if (last.tool_call_id === 'c0') {
      sse(res, { content: 'Thanks, Claude: ' + text(last) })
      return end(res)
    }
    if (last.role === 'user')
      return sse(res, { tool_calls: calls([['b0', 'ask_user', { questions: [{ question: 'Who uses the export?', options: [{ label: 'Accounting' }, { label: 'Everyone' }] }] }]]) }), end(res, 'tool_calls')
    if (last.tool_call_id === 'b0')
      return (
        sse(res, {
          tool_calls: calls([
            ['b1', 'kanban_create', { title: 'Accounting export', description: '**Need**: monthly export' }],
            ['b2', 'kanban_create', { title: 'Export settings' }],
            ['b3', 'kanban_add_note', { text: 'Used by accounting only.' }],
            ['b4', 'edit_file', { path: 'src/main.go', old_string: 'Bonjour', new_string: 'Salut' }],
          ]),
        }),
        end(res, 'tool_calls')
      )
    sse(res, { content: 'Tickets written.' })
    return end(res)
  }
  // The ticket is not in the system prompt (#216): the model reads it with kanban_get.
  const ticketId = Number(/kanban_get \(id (\d+)\)/.exec(msgs[0].content)?.[1])
  if (firstUser.startsWith('Develop ticket')) {
    if (last.role === 'user') return sse(res, { tool_calls: calls([['g0', 'kanban_get', { id: ticketId }]]) }), end(res, 'tool_calls')
    const ids = [...text(msgs.find((m) => m.tool_call_id === 'g0')).matchAll(/\(id (\d+)\)/g)].map((m) => Number(m[1]))
    if (last.tool_call_id === 'g0')
      return (
        sse(res, {
          tool_calls: calls([
            ['d1', 'kanban_goal', { action: 'check', id: ids[0] }],
            ['d2', 'kanban_goal', { action: 'check', id: ids[1] }],
            ['d3', 'kanban_move', { status: 'done' }],
            ['d4', 'kanban_move', { status: 'to_test', test_summary: 'Open **/export** and check the CSV.' }],
            ['d5', 'kanban_add_note', { text: 'Erratum: '.repeat(120) }],
            ['d6', 'kanban_add_note', { text: 'The CSV uses `;` as separator.' }],
            ['d7', 'kanban_goal', { action: 'add', title: 'Temporary goal' }],
            ['d8', 'kanban_goal', { action: 'delete', id: ids[1] + 1 }],
            ['d9', 'kanban_goal', { action: 'edit', id: ids[1], title: 'The CSV has a header row' }],
            ['d10', 'kanban_feedback', { action: 'add', kind: 'info', text: 'Exports over 10k rows take 2 s.', complexity: 'high' }],
          ]),
        }),
        end(res, 'tool_calls')
      )
    sse(res, { content: 'Development finished.' })
    return end(res)
  }
  if (firstUser.startsWith('Handle this test feedback')) {
    if (last.role === 'user') return sse(res, { tool_calls: calls([['g0', 'kanban_get', { id: ticketId }]]) }), end(res, 'tool_calls')
    const id = Number(/\(id (\d+), Bug/.exec(text(msgs.find((m) => m.tool_call_id === 'g0')))?.[1])
    if (last.tool_call_id === 'g0') return sse(res, { tool_calls: calls([['f1', 'kanban_feedback', { action: 'done', id }]]) }), end(res, 'tool_calls')
    sse(res, { content: 'Feedback handled.' })
    return end(res)
  }
  if (firstUser.startsWith('Types:')) {
    // One question of each type (choice, idea, compare, rank, scenario) plus a legacy one,
    // then an invalid call (compare with three options) that must be refused.
    if (last.role === 'user')
      return (
        sse(res, {
          tool_calls: calls([
            [
              't1',
              'ask_user',
              {
                questions: [
                  { question: 'Which color?', type: 'choice', options: [{ label: 'Blue', pros: ['calm'] }, { label: 'Red', cons: ['loud'] }] },
                  { question: 'Should the export include a header row?', type: 'idea' },
                  { question: 'CSV or JSON as the default format?', type: 'compare', options: [{ label: 'CSV', pros: ['simple'] }, { label: 'JSON', pros: ['structured'] }] },
                  { question: 'Rank the fields by importance.', type: 'rank', top: 2, options: [{ label: 'id' }, { label: 'total' }, { label: 'date' }, { label: 'email' }] },
                  { question: 'When the file is empty, which file is written?', type: 'scenario', situation: 'The export runs at midnight and no rows are produced.', options: [{ label: 'None' }, { label: 'An empty file' }] },
                  { question: 'Which priority?', options: [{ label: 'High' }, { label: 'Normal' }] },
                  { question: 'Anything else to add?', options: [{ label: 'Yes' }, { label: 'No' }] },
                ],
              },
            ],
            [
              't1bad',
              'ask_user',
              {
                questions: [
                  { question: 'How many formats?', type: 'compare', options: [{ label: 'CSV' }, { label: 'JSON' }, { label: 'XML' }] },
                ],
              },
            ],
          ]),
        }),
        end(res, 'tool_calls')
      )
    if (msgs.some((m) => m.role === 'tool' && m.tool_call_id === 't1')) return sse(res, { content: 'Types noted.' }), end(res)
    sse(res, { content: 'Types done.' })
    return end(res)
  }
  if (firstUser.startsWith('Graph:') || firstUser.startsWith('GraphOff:')) {
    // A small graph: Mode (Solo → Difficulty → Hard → Permadeath; Coop → Players), then
    // Platform; plus two invalid graphs (unknown next, a cycle) refused by the pod.
    const graph = [
      { question: 'Mode?', id: 'a', options: [{ label: 'Solo', next: 'c' }, { label: 'Coop', next: 'd' }] },
      { question: 'Platform?', options: [{ label: 'PC' }, { label: 'Phone' }] },
      { question: 'Difficulty?', id: 'c', options: [{ label: 'Hard', next: 'e' }, { label: 'Easy' }] },
      { question: 'How many players?', id: 'd', options: [{ label: '2' }, { label: '4' }] },
      { question: 'Permadeath?', id: 'e', type: 'idea' },
    ]
    if (last.role === 'user')
      return (
        sse(res, {
          tool_calls: calls([
            ['g1', 'ask_user', { questions: graph }],
            ['g2', 'ask_user', { questions: [{ question: 'Lost?', options: [{ label: 'x', next: 'zz' }, { label: 'y' }] }] }],
            [
              'g3',
              'ask_user',
              {
                questions: [
                  { question: 'Start?', options: [{ label: 'x', next: 'p' }, { label: 'y' }] },
                  { question: 'P?', id: 'p', options: [{ label: 'x', next: 'q' }, { label: 'y' }] },
                  { question: 'Q?', id: 'q', options: [{ label: 'x', next: 'p' }, { label: 'y' }] },
                ],
              },
            ],
          ]),
        }),
        end(res, 'tool_calls')
      )
    sse(res, { content: 'Graph noted.' })
    return end(res)
  }
  if (firstUser.startsWith('TypesM:')) {
    // One idea (answered by swiping the card) and one compare (stacked on a mobile viewport).
    if (last.role === 'user')
      return (
        sse(res, {
          tool_calls: calls([
            [
              'mm',
              'ask_user',
              {
                questions: [
                  { question: 'Ship it right away?', type: 'idea' },
                  { question: 'Drawer on the left or the right?', type: 'compare', options: [{ label: 'Left' }, { label: 'Right' }] },
                ],
              },
            ],
          ]),
        }),
        end(res, 'tool_calls')
      )
    if (msgs.some((m) => m.role === 'tool' && m.tool_call_id === 'mm')) return sse(res, { content: 'Mobile types noted.' }), end(res)
    sse(res, { content: 'Mobile types noted.' })
    return end(res)
  }
  if (last.role === 'user')
    return (
      sse(res, {
        content: 'A few questions.',
        tool_calls: calls([
          [
            'q1',
            'ask_user',
            {
              questions: [
                { question: 'Which format?', header: 'Format', options: [{ label: 'CSV (recommended)', description: 'simple' }, { label: 'JSON' }] },
                { question: 'Which columns?', options: [{ label: 'id' }, { label: 'total' }, { label: 'date' }], multiple: true },
                { question: 'Priority?', options: [{ label: 'High' }, { label: 'Normal' }] },
              ],
            },
          ],
        ]),
      }),
      end(res, 'tool_calls')
    )
  if (last.role === 'tool' && last.tool_call_id === 'q1')
    return (
      sse(res, {
        tool_calls: calls([
          ['k1', 'kanban_create', { title: 'Export JSON', description: 'Columns: id, date', priority: 'high', files: ['src/main.go'] }],
          ['k2', 'kanban_list', {}],
          ['k3', 'kanban_set_plan', { plan: 'x', goals: ['y'] }],
          ['k4', 'kanban_create', { title: 'Verbose', description: 'blah '.repeat(400) }],
        ]),
      }),
      end(res, 'tool_calls')
    )
  sse(res, { content: 'Ticket created.' })
  end(res)
})

run(async ({ page, browser }) => {
  // The views of the Kanban are frames of the page (#158).
  const kp = inFrames(page)
  // The Kanban is an external official plugin (#158): its release, or E2E_PLUGIN_KANBAN.
  await installOfficial('kanban')
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  page.on('dialog', (d) => d.accept())
  acceptConfirms(page)
  try {
    await openProject(page)
    await kp.click('.rail-right .rail-btn[title^="Assistant"]')
    await kp.click('.ai-empty button:has-text("Add a model server")')
    await kp.fill('.ai-servers input[name=url]', `127.0.0.1:${fake.address().port}`)
    await kp.click('.ai-servers button:has-text("Add")')
    await kp.waitForSelector('.ai-server-row:has-text("127.0.0.1")')
    await kp.click('.ai-servers :is(.modal-head, .ide-modal-head) button')
    await kp.waitForSelector('[data-testid=model-pill]:has-text("fake-model")')

    await kp.fill('.ai-composer .ed-content', 'Write down a ticket for the export')
    await page.keyboard.press('Enter')
    await kp.waitForSelector('[data-testid=ai-ask-question]', { timeout: 10000 })
    const names = toolNames(requests[0])
    assert(['kanban_list', 'kanban_get', 'kanban_create', 'ask_user'].every((n) => names.includes(n)), 'reading kanban tools and ask_user offered')
    assert(!names.includes('kanban_set_plan') && !names.includes('kanban_move'), 'no changing tool without a linked ticket')
    assert(requests[0].messages[0].content.includes('ask_user'), 'the prompt introduces ask_user')
    await kp.waitForSelector('[data-testid=send]')
    assert(requests.length === 1, 'the turn stops on the questions')

    // Question 1: a single choice moves on.
    assert((await kp.textContent('[data-testid=ai-ask-question]')).includes('Which format'), 'first question shown')
    await kp.click('.ai-ask-option:has-text("JSON")')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Which columns")')
    assert(true, 'single choice: next question')
    // Question 2: several choices.
    await kp.click('.ai-ask-option:has-text("id")')
    await kp.click('.ai-ask-option:has-text("date")')
    await kp.click('[data-testid=ai-ask-next]')
    // Question 3: free answer.
    await kp.fill('[data-testid=ai-ask-free]', 'Very high')
    await kp.click('[data-testid=ai-ask-next]')
    await kp.waitForSelector('.ai-ask-recap')
    const recap = await kp.textContent('.ai-ask-recap')
    assert(recap.includes('JSON') && recap.includes('id ; date') && recap.includes('Very high'), 'summary: ' + recap)
    await page.screenshot({ path: OUT + '/ask-recap.png' })
    await kp.click('[data-testid=ai-ask-send]')
    await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("Ticket created.")', { timeout: 15000 })
    const answer = text(requests[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'q1'))
    assert(answer.includes('Which format?') && answer.includes('→ JSON') && answer.includes('id ; date') && answer.includes('Very high'), 'answers sent back to the model: ' + answer)
    assert(await kp.isVisible('[data-testid=ai-ask] .badge:has-text("answered")'), 'card marked answered')

    const res = requests[2].messages.filter((m) => m.role === 'tool')
    const by = (id) => text(res.find((m) => m.tool_call_id === id))
    assert(by('k1').includes('Ticket #1 created'), 'kanban_create : ' + by('k1'))
    assert(by('k2').includes('#1 [New]') && by('k2').includes('Export JSON'), 'kanban_list : ' + by('k2'))
    assert(by('k3').includes('not linked to a ticket'), 'kanban_set_plan refused without a linked ticket')
    assert(by('k4').includes('description too long (1999 characters, 1500 max)'), 'a description too long is refused: ' + by('k4').slice(0, 60))

    await kp.click('.rail-left .rail-btn[title^="Kanban"]')
    await kp.waitForSelector('[data-testid=kanban-panel] [data-testid=ticket-card-1]:has-text("Export JSON")')
    await kp.click('[data-testid=ticket-card-1]')
    await kp.waitForSelector('[data-testid=ticket-view]')
    assert((await kp.textContent('.tk-side')).includes('src/main.go'), 'file linked by the model')
    await kp.click('.tk-section-toggle:has-text("History")')
    assert(await kp.isVisible('.tk-events .badge:has-text("assistant")'), 'history: created by the assistant')

    // Plan generated by the model from the ticket.
    const before = requests.length
    await kp.click('[data-testid=ticket-plan-generate]')
    await kp.waitForSelector('[data-testid=ticket-status]:has-text("To do")', { timeout: 15000 })
    assert((await kp.$eval('[data-testid=ticket-size]', (e) => e.value)) === 'l', 'the plan of the model sets the size of the ticket')
    const rp = requests[before]
    const sys = rp.messages[0].content
    assert(sys.includes('Ticket linked to this conversation') && sys.includes('implementation plan') && sys.includes('kanban_get (id 1)') && !sys.includes('# Ticket #1 · Export JSON'), 'prompt of the Plan role, the ticket read with kanban_get (#216)')
    const pn = toolNames(rp)
    assert(pn.includes('kanban_set_plan') && pn.includes('kanban_feedback') && !pn.includes('exit_plan_mode'), 'tools of the ticket plan: ' + pn.join(','))
    assert(await kp.isVisible('[data-testid=ai-ticket]:has-text("#1")'), 'ticket bar in the assistant')
    await kp.waitForSelector('[data-testid=ai-ticket] .ai-bar-dot.st-todo', { timeout: 5000 })
    assert(true, 'the status of the ticket as a dot on its icon')
    assert((await kp.textContent('[data-testid=ai-role]')) === 'Plan', 'the role pill of the conversation on the ticket: ' + (await kp.textContent('[data-testid=ai-role]')))
    assert(await kp.isVisible('[data-testid=ai-gentime]'), 'the generation time is shown on a ticket conversation')
    const barOrder = await kp.$$eval('[data-testid=ai-topbar] > *', (e) => e.map((x) => [x.getAttribute('data-testid') ?? x.className, Math.round(x.getBoundingClientRect().left)]))
    assert(barOrder.map((x) => x[0]).filter((n) => n !== 'grow').join(',') === 'ai-gentime,ai-ticket,ai-role', 'bar order: time, then the ticket and the role on the right (no shells part: none running): ' + JSON.stringify(barOrder))
    assert(barOrder.at(-1)[1] > barOrder[0][1] + 100, 'the ticket and the role pill sit at the right end of the bar')
    await kp.waitForSelector('[data-testid=ticket-plan] li:has-text("Add the route")')
    assert((await kp.$$('[data-testid=ticket-goal]')).length === 2, 'goals written by the model')
    assert((await kp.textContent('[data-testid=ticket-goal-desc]')) === 'curl /export gives 200', 'goal with its description')
    await kp.waitForSelector('[data-testid=ticket-chat]:has-text("Plan")', { timeout: 5000 })
    assert(true, 'conversation listed in the ticket')

    // Development session: goals checked, the model cannot close, moves to To test.
    // Not a git repository: after confirmation, development in the project folder itself.
    const before2 = requests.length
    await kp.click('[data-testid=ticket-start]')
    await kp.waitForSelector('[data-testid=ticket-status]:has-text("In progress")', { timeout: 15000 })
    assert(requests.length === before2, 'Start development starts no conversation')
    await kp.click('[data-testid=ticket-dev-session]')
    await kp.waitForSelector('[data-testid=ticket-status]:has-text("To test")', { timeout: 15000 })
    const rd = requests[before2]
    assert(rd.messages[0].content.includes('You **develop** this ticket') && toolNames(rd).includes('edit_file'), 'dev role in Build mode')
    assert(rd.chat_template_kwargs?.reasoning_effort === 'low', 'a low complexity ticket is developed with a low effort: ' + rd.chat_template_kwargs?.reasoning_effort)
    await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("Development finished.")', { timeout: 10000 })
    const rr = requests[requests.length - 1].messages.filter((m) => m.role === 'tool')
    const d3 = text(rr.find((m) => m.tool_call_id === 'd3'))
    assert(d3.includes('the model cannot move'), 'the model cannot close the ticket: ' + d3)
    const d5 = text(rr.find((m) => m.tool_call_id === 'd5'))
    for (const title of ['Notes', 'Goals', 'Plan conversations', 'Development conversations']) await unfold(page, title)
    assert(d5.includes('note too long') && !(await kp.isVisible('[data-testid=ticket-note]:has-text("Erratum")')), 'a long note of the model is refused: ' + d5.slice(0, 60))
    await kp.waitForSelector('[data-testid=ticket-note]:has-text("separator")')
    assert(await kp.isVisible('[data-testid=ticket-note]:has-text("separator") [data-testid=ticket-chat-link]:has-text("Development")'), 'the note of the model links its conversation')
    assert((await kp.$$('[data-testid=ticket-goal].done')).length === 2, 'goals checked by the model')
    assert(await kp.isVisible('[data-testid=ticket-test] strong:has-text("/export")'), 'test summary shown')
    assert(
      (await kp.$$eval('[data-testid=ticket-goal]', (l) => l.map((e) => e.querySelector('.tk-goal-title').textContent))).join('|').endsWith('The CSV has a header row'),
      'goals edited and deleted by the model',
    )
    assert(await kp.isVisible('[data-testid=ticket-feedback-item].k-info:has-text("10k rows")'), 'test feedback added by the model')
    assert((await kp.$$('[data-testid=ticket-chat]')).length === 2, 'two linked conversations')
    await page.screenshot({ path: OUT + '/kanban-ai.png' })

    // Test feedback handled by a fix session: the model marks it done.
    await kp.selectOption('[data-testid=ticket-feedback-kind]', 'bug')
    await kp.fill('[data-testid=ticket-feedback-input]', 'The header is missing')
    await kp.click('[data-testid=ticket-feedback-add]')
    await kp.waitForSelector('[data-testid=ticket-feedback-item]:has-text("header is missing")')
    // The times are read when the ticket changes: this feedback, after the development.
    assert(
      (await kp.$$('[data-testid=ticket-chat-time]')).length === 2 && (await kp.getAttribute('[data-testid=ticket-chat-time]', 'title')).includes('Time of the answers'),
      'each conversation shows the time of its answers: ' + (await kp.$$eval('[data-testid=ticket-chat] , [data-testid=ticket-chat-time]', (l) => l.map((e) => e.textContent.trim()).join(' | '))),
    )
    const before4 = requests.length
    await kp.click('[data-testid=ticket-feedback-item]:has-text("header is missing") [data-testid=ticket-feedback-session]')
    await kp.waitForSelector('[data-testid=ticket-feedback-item].done:has-text("header is missing")', { timeout: 15000 })
    const rf = requests[before4]
    assert(rf.messages[0].content.includes('**test feedback**') && text(rf.messages[1]).includes('The header is missing'), 'correction role on the feedback')
    await kp.waitForSelector('[data-testid=ticket-feedback-item]:has-text("header is missing") [data-testid=ticket-chat-link]', { timeout: 5000 })
    assert((await kp.textContent('[data-testid=ticket-status]')).includes('To test'), 'the ticket stays in To test')
    assert(true, 'feedback marked done by the model, linked to its conversation')

    // Reopen the plan conversation from the ticket.
    await kp.click('[data-testid=ticket-chat]:has-text("Plan")')
    await kp.waitForSelector('.ai-msg.assistant .md:has-text("Plan saved.")', { timeout: 5000 })
    assert(true, 'plan conversation reopened from the ticket')

    // The question types: one of each (choice, idea, compare, rank, scenario), a legacy one,
    // a note, "I don't know", and an invalid call (compare with three options) refused.
    await kp.click('[data-testid=assistant-new]')
    await kp.fill('.ai-composer .ed-content', 'Types: which widgets')
    await page.keyboard.press('Enter')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Which color?")', { timeout: 10000 })
    // Q1 choice: a note, then the pick (a single choice moves on by itself).
    await kp.click('[data-testid=ai-ask-note]')
    await kp.fill('[data-testid=ai-ask-note-input]', 'prefers it calm')
    await kp.click('.ai-ask-option:has-text("Blue")')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("header row")')
    // Q2 idea: "Yes, but…" opens the text and keeps the user (no auto-advance).
    await kp.click('[data-testid=ai-ask-idea-but]')
    await kp.fill('[data-testid=ai-ask-idea-text]', 'and a footer too')
    assert(await kp.isVisible('[data-testid=ai-ask-question]:has-text("header row")'), 'the idea stays while the "Yes, but…" text is typed')
    await kp.click('[data-testid=ai-ask-next]')
    // Q3 compare: a pick of the two.
    await kp.waitForSelector('[data-testid=ai-ask-compare]')
    await kp.click('.ai-ask-compare .ai-ask-option:has-text("JSON")')
    await kp.waitForSelector('[data-testid=ai-ask-rank]')
    // Q4 rank: move "email" to the top, then next.
    const email = page.locator('[data-testid=ai-ask-rank-item]').filter({ hasText: 'email' })
    await email.locator('[data-testid=ai-ask-rank-up]').click()
    await email.locator('[data-testid=ai-ask-rank-up]').click()
    await email.locator('[data-testid=ai-ask-rank-up]').click()
    await kp.click('[data-testid=ai-ask-next]')
    // Q5 scenario: the situation is shown, then a pick.
    await kp.waitForSelector('[data-testid=ai-ask-situation]')
    assert((await kp.textContent('[data-testid=ai-ask-situation]')).includes('at midnight'), 'the scenario situation is shown')
    await kp.click('.ai-ask-scenario .ai-ask-option:has-text("None")')
    // Q6 legacy (no type): "I don't know".
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Which priority?")')
    await kp.click('[data-testid=ai-ask-dontknow]')
    await kp.click('[data-testid=ai-ask-next]')
    // Q7: "Up to you" (the other special answer).
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Anything else")')
    await kp.click('[data-testid=ai-ask-uptoyou]')
    await kp.click('[data-testid=ai-ask-next]')
    await kp.waitForSelector('.ai-ask-recap')
    const typesRecap = await kp.textContent('.ai-ask-recap')
    assert(typesRecap.includes('Blue') && typesRecap.includes('and a footer too') && typesRecap.includes('JSON') && typesRecap.includes('None') && typesRecap.includes('1. email, 2. id') && typesRecap.includes("I don't know") && typesRecap.includes('Up to you'), 'recap: ' + typesRecap)
    await page.screenshot({ path: OUT + '/ask-types.png' })
    await kp.click('[data-testid=ai-ask-send]')
    await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("Types noted.")', { timeout: 15000 })
    const t1res = requests[requests.length - 1].messages.filter((m) => m.role === 'tool')
    const t1 = text(t1res.find((m) => m.tool_call_id === 't1'))
    assert(t1.includes('[choice]') && t1.includes('Blue') && t1.includes('and a footer too') && t1.includes('[compare]') && t1.includes('JSON') && t1.includes('[rank]') && t1.includes('1. email, 2. id (the top 2 only)') && t1.includes('[scenario]') && t1.includes('None') && t1.includes('I don\'t know (the user does not know: offer concrete examples or options)') && t1.includes('Up to you (left to you: decide and say what you chose)') && t1.includes('note: prefers it calm'), 'answers by type sent back: ' + t1)
    const t1bad = t1res.find((m) => m.tool_call_id === 't1bad')
    assert(t1bad && text(t1bad).includes('compare') && text(t1bad).includes('exactly 2 options') && text(t1bad).includes('it has 3'), 'invalid compare refused, naming the rule: ' + (t1bad ? text(t1bad) : '(missing)'))
    assert(await kp.isVisible('[data-testid=ai-ask] .badge:has-text("answered")'), 'types card marked answered')
    const folded = await kp.textContent('[data-testid=ai-ask]:has(.badge:has-text("answered")):has-text("Which color?")')
    assert(folded.includes('Blue') && folded.includes('prefers it calm') && folded.includes('1. email, 2. id'), 'the folded card shows the answers and the note: ' + folded)

    // Briefing mode: questions, then tickets created and linked to the conversation.
    await kp.click('[data-testid=assistant-new]')
    await kp.click('.ai-composer .ed-content')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await kp.waitForSelector('[data-testid=ai-mode].briefing:has-text("Briefing")')
    assert(true, 'Shift+Tab twice from Build: Briefing mode')
    const before3 = requests.length
    await kp.fill('.ai-composer .ed-content', 'Brief: an export for accounting')
    await page.keyboard.press('Enter')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Who uses the export")', { timeout: 10000 })
    const rb = requests[before3]
    const bn = toolNames(rb)
    assert(rb.messages[0].content.includes('**Briefing mode**') && rb.messages[0].content.includes('Acceptance criteria'), 'system prompt of the Briefing mode')
    assert(bn.includes('ask_user') && bn.includes('kanban_create') && !bn.includes('exit_plan_mode') && !bn.includes('kanban_add_note'), 'tools of the Briefing mode: ' + bn.join(','))
    await kp.click('.ai-ask-option:has-text("Accounting")')
    await kp.click('[data-testid=ai-ask-send]')
    await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("Tickets written.")', { timeout: 15000 })
    const rbr = requests[requests.length - 1].messages.filter((m) => m.role === 'tool')
    const bt = (id) => text(rbr.find((m) => m.tool_call_id === id))
    assert(bt('b1').includes('Ticket #2 created') && bt('b1').includes('now linked'), 'first ticket created, conversation linked: ' + bt('b1'))
    assert(bt('b2').includes('Ticket #3 created') && bt('b2').includes('stays linked to ticket #2'), 'second ticket created: ' + bt('b2'))
    assert(bt('b3') === 'Note added.', 'note added to the linked ticket: ' + bt('b3'))
    assert(bt('b4').includes('Briefing mode'), 'no file change in Briefing mode')
    assert(await kp.isVisible('[data-testid=ai-ticket]:has-text("#2")'), 'ticket bar of the created ticket')
    assert(await kp.isVisible('.ai-briefing-badge'), 'answers marked Briefing')
    if (!(await kp.isVisible('[data-testid=kanban-panel]'))) await kp.click('.rail-left .rail-btn[title^="Kanban"]')
    await kp.click('[data-testid=ticket-card-3]')
    await kp.waitForSelector('[data-testid=ticket-view] [data-testid=ticket-title]:has-text("Export settings")')
    await kp.waitForSelector('.tk-row:has(.kb-role.r-briefing) [data-testid=ticket-chat]:has-text("Brief:")', { timeout: 5000 })
    assert(true, 'the second ticket lists the briefing conversation')
    await kp.click('[data-testid=ticket-card-2]')
    await kp.waitForSelector('[data-testid=ticket-note]:has-text("accounting only")', { timeout: 5000 })
    assert(await kp.isVisible('.tk-row:has(.kb-role.r-briefing) [data-testid=ticket-chat]:has-text("Brief:")'), 'the first ticket has the note and the conversation')

    // Claude Code replies in the briefing conversation, then answers the question of the assistant.
    const mcpTool = (name, args) =>
      fetch(process.env.E2E_URL + '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mcpToken() },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { cwd: WS + '/demo', id: 2, ...args } } }),
      })
        .then((r) => r.json())
        .then((r) => ({ text: r.result.content[0].text, failed: !!r.result.isError }))
    const chatId = (await mcpTool('kanban_get', {})).text.match(/\(chat ([a-z0-9]+)\)/)[1]
    const sent = await mcpTool('kanban_reply', { chat: chatId, message: 'Claude Code here: which format?' })
    assert(!sent.failed && sent.text.includes('Message sent'), 'kanban_reply: ' + sent.text)
    await kp.waitForSelector('[data-testid=ai-author-claude]', { timeout: 10000 })
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("CSV or JSON?")', { timeout: 10000 })
    assert((await kp.textContent('.ai-msg.user:has([data-testid=ai-author-claude])')).includes('which format?'), 'the message of Claude is shown with its badge')
    const active = await mcpTool('assistant_list', { active: true })
    assert(!active.failed && active.text.includes(chatId), 'assistant_list finds a conversation waiting for the user: ' + active.text)
    const readPending = await mcpTool('assistant_read', { chat: chatId })
    assert(!readPending.failed && readPending.text.includes('Questions tool of the IDE') && readPending.text.includes('[options: CSV | JSON]'), 'assistant_read lists the pending question')
    const pendingText = (await mcpTool('kanban_conversation', { chat: chatId })).text
    assert(pendingText.includes('Waiting for the answers') && pendingText.includes('[options: CSV | JSON]'), 'kanban_conversation lists the waiting questions: ' + pendingText)
    const answered = await mcpTool('kanban_answer', { chat: chatId, answers: [['JSON']] })
    assert(!answered.failed, 'kanban_answer: ' + answered.text)
    await kp.waitForSelector('[data-testid=ai-ask-by-claude]', { timeout: 10000 })
    await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("Thanks, Claude")', { timeout: 10000 })
    assert((await kp.textContent('.ai-msg.assistant:not(.live) .md:has-text("Thanks, Claude")')).includes('JSON'), 'the assistant gets the answers of Claude')

    // The MCP can start and steer a conversation without a ticket.
    const started = await mcpTool('assistant_start', { title: 'MCP conversation', message: 'MCP first message' })
    assert(!started.failed, 'assistant_start: ' + started.text)
    const externalChat = started.text
    const listed = await mcpTool('assistant_list', { query: 'MCP conversation' })
    assert(!listed.failed && listed.text.includes(externalChat) && listed.text.includes(' · build · '), 'assistant_list: ' + listed.text)
    const second = await mcpTool('assistant_send', { chat: externalChat, message: 'MCP follow-up' })
    assert(!second.failed, 'assistant_send: ' + second.text)
    await page.waitForFunction(async ({ url, token, cwd, chat }) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'assistant_read', arguments: { cwd, chat } } }),
      })
      const reply = await response.json()
      return reply.result?.content[0]?.text.includes('## Assistant\nMCP received MCP follow-up')
    }, { url: process.env.E2E_URL + '/mcp', token: mcpToken(), cwd: WS + '/demo', chat: externalChat })
    const developerRequest = requests.find((req) => text(req.messages.find((msg) => msg.role === 'user')) === 'MCP first message')
    assert(toolNames(developerRequest).join(',') === 'ask_user', 'Developer assistant_start receives the question tool')

    const observer = mcpToken('observer')
    const foreignChat = await mcp('assistant_send', { chat: externalChat, message: 'unexpected' }, observer)
    assert(foreignChat.result.isError, 'Supervisor cannot steer another credential’s conversation')
    await kp.click('[data-testid=assistant-settings]')
    await kp.click('.ai-tab:has-text("Servers")')
    await kp.click('.ai-server-row button:has-text("Edit")')
    await kp.check('.ai-servers input[name=children]')
    await kp.click('.ai-servers button:has-text("Save")')
    await kp.click('.ai-tab:has-text("Sub-agents")')
    await page.selectOption('select[name=childServer]', { index: 1 })
    await page.selectOption('select[name=childModel]', 'fake-model')
    await kp.click('.ai-servers :is(.modal-head, .ide-modal-head) button')
    const historyButton = '.ai-panel button[title="Conversations of the project"]'
    await kp.click(historyButton)
    await kp.waitForSelector('.ai-chat-open:has-text("MCP conversation")')
    const supervisorRow = page.locator('.ai-chat-open').filter({ hasText: 'Supervisor smoke test' })
    const supervisorChat = await mcp('assistant_start', { title: 'Supervisor smoke test', message: 'Supervisor conversation' }, observer)
    assert(!supervisorChat.result.isError, 'an explicit Supervisor Assistant grant starts a conversation')
    await supervisorRow.waitFor({ timeout: 5000 })
    assert(true, 'the open Assistant sidebar lists a new Supervisor conversation')
    const { chat: supervisorID, turn: supervisorTurn, url, local_url: localURL } = JSON.parse(supervisorChat.result.content[0].text)
    assert(url === localURL && new URL(localURL).searchParams.get('chat') === supervisorID, 'MCP returns both conversation links with its resource ID')
    const waited = await mcp('assistant_wait', { chat: supervisorID, turn: supervisorTurn }, observer)
    assert(!waited.result.isError && JSON.parse(waited.result.content[0].text).answer === 'Supervisor analysis finished.', 'Supervisor can wait for its answer')
    const transcript = (await mcp('assistant_read', { chat: supervisorID, tools: true }, observer)).result.content[0].text
    const supervisorRequest = requests.find((req) => req.messages.some((msg) => msg.content === 'Supervisor conversation'))
    assert(supervisorRequest && toolNames(supervisorRequest).sort().join(',') === 'ask_user,list_dir,read_file', 'Supervisor Assistant receives the scoped analysis tools')
    assert(transcript.includes('Tool unavailable in this MCP conversation'), 'the Assistant rejects a tool emitted despite discovery')
    assert(!fs.existsSync(WS + '/demo/mcp-forbidden'), 'the denied Assistant tool creates no file')
    await page.reload()
    await supervisorRow.waitFor({ timeout: 10000 })
    await supervisorRow.click()
    await kp.waitForSelector('.ai-msg.user:has-text("Supervisor conversation")')
    assert(true, 'the Assistant sidebar reopens the MCP conversation after reload')
    const coldContext = await browser.newContext()
    try {
      const cold = await coldContext.newPage()
      await cold.goto(localURL)
      await cold.locator('[name=token]').fill(process.env.E2E_TOKEN)
      await cold.getByRole('button', { name: 'Open', exact: true }).click()
      await cold.locator('.ai-msg.user:has-text("Supervisor conversation")').waitFor()
      await cold.locator('.ai-msg.assistant .md:has-text("Supervisor analysis finished.")').waitFor()
      assert(true, 'a cold local link opens the MCP conversation after token sign-in')
    } finally {
      await coldContext.close()
    }
    if (await kp.isVisible('[data-testid=ai-sidebar]')) await kp.click(historyButton)

    // Mobile: the idea is answered by swiping the card (right = Yes), and the compare stacks.
    await kp.click('[data-testid=assistant-new]')
    await kp.fill('.ai-composer .ed-content', 'TypesM: swipe')
    await page.keyboard.press('Enter')
    await kp.waitForSelector('[data-testid=ai-ask-idea]', { timeout: 10000 })
    await kp.$eval('[data-testid=ai-ask-idea]', (el) => {
      const target = el.querySelector('.ai-ask-idea-proposal')
      const r = target.getBoundingClientRect()
      const x = r.x + r.width / 2
      const y = r.y + r.height / 2
      const fire = (type, cx, cy) =>
        target.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: cx, clientY: cy, button: 0 }),
        )
      fire('pointerdown', x, y)
      fire('pointermove', x + 50, y)
      fire('pointermove', x + 130, y)
      fire('pointerup', x + 150, y)
    })
    await kp.waitForSelector('[data-testid=ai-ask-compare]', { state: 'visible', timeout: 10000 })
    assert(true, 'swiping the idea card right answers "Yes" and moves on to the compare')
    // Narrow viewport (the phone layout, the assistant in use in front): the card goes on
    // where it was, the two cards stack (a single grid column).
    await page.setViewportSize({ width: 390, height: 844 })
    await kp.waitForSelector('[data-testid=ai-ask-compare]', { state: 'visible', timeout: 10000 })
    const tracks = await kp.$eval('[data-testid=ai-ask-compare]', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    await page.screenshot({ path: OUT + '/ask-types-mobile.png' })
    assert(tracks === 1, 'compare stacked on a mobile viewport (tracks: ' + tracks + ')')
    await kp.click('.ai-ask-compare .ai-ask-option:has-text("Left")')
    await kp.click('[data-testid=ai-ask-next]')
    await page.setViewportSize({ width: 1440, height: 900 })
    await kp.click('[data-testid=ai-ask-send]')
    await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("Mobile types noted.")', { timeout: 15000 })
    const mm = text(requests[requests.length - 1].messages.filter((m) => m.role === 'tool').find((m) => m.tool_call_id === 'mm'))
    assert(mm.includes('[idea]') && mm.includes('→ Yes') && mm.includes('[compare]') && mm.includes('Left'), 'swipe (Yes) and compare (Left) sent back: ' + mm)
    assert(true, 'mobile: swipe and compare answered')

    // A graph of questions: the branch of the answer only, a breadcrumb, Previous + another
    // answer changing the path, invalid graphs refused.
    await kp.click('[data-testid=assistant-new]')
    await kp.fill('.ai-composer .ed-content', 'Graph: a game')
    await page.keyboard.press('Enter')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Mode?")', { timeout: 10000 })
    await kp.click('.ai-ask-option:has-text("Solo")')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Difficulty?")')
    await kp.click('.ai-ask-option:has-text("Hard")')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Permadeath?")')
    assert((await kp.textContent('[data-testid=ai-ask-question] [data-testid=ai-ask-crumbs]')) === 'Solo › Hard', 'breadcrumb of the branch')
    await kp.click('[data-testid=ai-ask-idea-yes]')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Platform?")')
    for (let i = 0; i < 3; i++) await kp.click('.ai-ask .btn:has-text("Previous")')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Mode?")')
    await kp.click('.ai-ask-option:has-text("Coop")')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("How many players?")')
    await kp.click('.ai-ask-option:has-text("4")')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Platform?")')
    await kp.click('.ai-ask-option:has-text("PC")')
    await kp.click('[data-testid=ai-ask-next]')
    await kp.waitForSelector('.ai-ask-recap')
    const graphRecap = await kp.textContent('.ai-ask-recap')
    assert(graphRecap.includes('How many players?') && !graphRecap.includes('Difficulty?') && graphRecap.includes('Coop'), 'recap follows the new branch: ' + graphRecap)
    await kp.click('[data-testid=ai-ask-send]')
    await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("Graph noted.")', { timeout: 15000 })
    let gres = requests[requests.length - 1].messages.filter((m) => m.role === 'tool')
    const g1 = text(gres.find((m) => m.tool_call_id === 'g1'))
    assert(g1.includes('2. [choice] Coop › How many players?\n   → 4') && g1.includes('3. [choice] Platform?') && g1.includes('Not asked (branch not taken): "Difficulty?", "Permadeath?".'), 'path sent back: ' + g1)
    assert(text(gres.find((m) => m.tool_call_id === 'g2')).includes('next "zz" names no question'), 'unknown next refused')
    assert(text(gres.find((m) => m.tool_call_id === 'g3')).includes('p → q → p form a cycle'), 'cycle refused')

    // Leaving the path: a free answer on a question with branches sends the round at once.
    await kp.click('[data-testid=assistant-new]')
    await kp.fill('.ai-composer .ed-content', 'GraphOff: a game')
    await page.keyboard.press('Enter')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Mode?")', { timeout: 10000 })
    await kp.click('.ai-ask-option:has-text("Solo")')
    await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Difficulty?")')
    await kp.fill('[data-testid=ai-ask-free]', 'Medium')
    assert((await kp.textContent('[data-testid=ai-ask-next]')).includes('Send the answers'), 'Next becomes Send when leaving the path')
    await kp.click('[data-testid=ai-ask-next]')
    await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("Graph noted.")', { timeout: 15000 })
    gres = requests[requests.length - 1].messages.filter((m) => m.role === 'tool')
    const off = text(gres.find((m) => m.tool_call_id === 'g1'))
    assert(off.includes('left the anticipated path at "Difficulty?" with: Medium') && off.includes('Not asked: "Platform?", "How many players?", "Permadeath?".'), 'off path sent back: ' + off)
    await kp.waitForSelector('[data-testid=ai-ask-offpath]')
    const offCard = await kp.textContent('[data-testid=ai-ask]:has([data-testid=ai-ask-offpath])')
    assert(offCard.includes('Solo') && offCard.includes('Medium') && !offCard.includes('Platform?'), 'folded card: the path and the badge: ' + offCard)

    {
      // MCP development in a Git worktree. Earlier cases use the non-Git development path.
      const repo = WS + '/demo'
      const git = (...args) => execFileSync('git', args, { cwd: repo })
      git('init', '-q', '-b', 'main')
      git('add', 'src/main.go')
      git('-c', 'user.name=e2e', '-c', 'user.email=e2e@x', 'commit', '-qm', 'Initial state')
      const mcpText = (response) => response.result.content[0].text
      const ok = async (name, args, token) => {
        const response = await mcp(name, args, token)
        assert(!response.result.isError, name + ': ' + mcpText(response))
        return mcpText(response)
      }
      const created = await ok('kanban_create', { title: 'MCP worktree fixture' })
      const id = Number(created.match(/Ticket #(\d+) created/i)?.[1])
      assert(id > 0, 'ticket created: ' + created)
      await ok('kanban_set_plan', { id, plan: 'Read the marker', goals: [{ title: 'Read the marker' }], size: 's', complexity: 'medium' })
      const missing = await mcp('kanban_develop', { id })
      assert(missing.result.isError && mcpText(missing).includes('call kanban_start first'), 'MCP development requires a worktree')
      const sup = mcpToken('supervisor')
      const supervisorTools = (await (await mcpRPC('tools/list', {}, sup)).json()).result.tools
      const supervisorPrepares = supervisorTools.some((tool) => tool.name === 'kanban_start')
      const prepared = supervisorPrepares
        ? await ok('kanban_start', { id }, sup)
        : await ok('kanban_start', { id, base: 'main' })
      const cwd = prepared.match(/^Worktree: (.+)$/m)?.[1]
      assert(cwd, 'kanban_start returns the worktree')

      // The standalone conversation belongs to the project family of cwd.
      const worktree = await page.context().newPage()
      const other = await page.context().newPage()
      const idleTitle = 'MCP conversation seen only at idle'
      try {
        // Delay the first history response until the update for the new conversation has arrived.
        let holdList
        const staleList = new Promise((resolve) => {
          holdList = resolve
        })
        await worktree.routeWebSocket('**/ws', (ws) => {
          const server = ws.connectToServer()
          let firstList
          ws.onMessage((msg) => {
            const req = JSON.parse(msg)
            if (firstList === undefined && req.method === 'llm.chats.list') firstList = req.id
            server.send(msg)
          })
          server.onMessage((msg) => {
            const reply = JSON.parse(msg)
            if (reply.event === 'assistant.update' && reply.data.title === idleTitle && reply.data.state !== 'idle') return
            if (firstList !== undefined && reply.id === firstList && holdList) {
              holdList(() => ws.send(msg))
              holdList = undefined
            } else ws.send(msg)
          })
        })
        const worktreeURL = prepared.match(/^Worktree in the IDE: (.+)$/m)[1]
        await worktree.goto(worktreeURL + '/tool/assistant')
        await worktree.locator('.ai-chat-open').filter({ hasText: 'MCP conversation' }).waitFor()
        const releaseStale = await staleList

        await other.goto(process.env.E2E_URL)
        await addProjectFolder(other, 'other')
        await other.waitForURL('**/project/*')
        await other.goto(other.url() + '/tool/assistant')
        await other.getByTestId('ai-sidebar').waitFor()

        await kp.click(historyButton)
        await kp.waitForSelector('[data-testid=ai-sidebar]')
        const title = 'MCP worktree conversation'
        const chatID = await ok('assistant_start', { cwd, title, message: 'MCP first message' })
        const row = (p) => p.locator('.ai-chat-open').filter({ hasText: title })
        await Promise.all([row(page).waitFor({ timeout: 5000 }), row(worktree).waitFor({ timeout: 5000 })])
        assert(true, 'a worktree MCP conversation appears in both open Assistant sidebars')
        releaseStale()
        const disappeared = await row(worktree).waitFor({ state: 'hidden', timeout: 1000 }).then(() => true, () => false)
        assert(!disappeared, 'a late history response does not hide the new MCP conversation')
        const read = await ok('assistant_read', { cwd, chat: chatID })
        assert(read.includes('MCP first message'), 'the MCP worktree can read its conversation')
        const foreign = await mcp('assistant_read', { cwd: WS + '/other', chat: chatID })
        assert(foreign.result.isError, 'the MCP grant rejects a read from an unrelated project')

        await Promise.all([worktree.reload(), other.reload()])
        await row(worktree).click({ timeout: 10000 })
        await worktree.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("MCP received MCP first message")')
        await other.waitForSelector('.ai-side-empty:has-text("No conversation for this project.")')
        assert(!(await row(other).count()), 'the worktree transcript survives reload and is absent from the unrelated project')
        const idle = await ok('assistant_start', { cwd, title: idleTitle, message: 'MCP first message' })
        await worktree.locator('.ai-chat-open').filter({ hasText: idleTitle }).click({ timeout: 5000 })
        await worktree.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("MCP received MCP first message")')
        assert(idle !== chatID, 'the first idle update publishes a new conversation to the open history')
      } finally {
        await Promise.all([worktree.close(), other.close()])
        if (await kp.isVisible('[data-testid=ai-sidebar]')) await kp.click(historyButton)
      }

      fs.writeFileSync(cwd + '/worktree-marker.txt', 'from the ticket worktree')
      const started = await ok('kanban_develop', { id })
      const chat = started.match(/conversation (\w+)\./)?.[1]
      assert(chat, 'development returns the conversation id: ' + started)
      const duplicate = await mcp('kanban_develop', { id })
      assert(duplicate.result.isError && mcpText(duplicate).includes(chat), 'MCP development rejects a second start during the first turn')
      const agent = await mcp('agent_start', { cwd, id, provider: 'claude' }, sup)
      assert(agent.result.isError && mcpText(agent).includes(chat), 'ACP cannot start while the Assistant owns the development')
      const ticket = await ok('kanban_get', { id })
      assert(ticket.includes('Linked conversations') && ticket.includes(chat), 'kanban_get lists the development conversation')

      const card = '[data-testid=ticket-card-' + id + ']'
      if (!(await kp.isVisible('[data-testid=kanban-panel]'))) await kp.click('.rail-left .rail-btn[title^="Kanban"]')
      await kp.waitForSelector(card)
      await kp.click(card)
      await kp.waitForSelector('[data-testid=ticket-view]:has-text("MCP worktree fixture")', { timeout: 15000 })
      if (await kp.isVisible('.tk-section.folded .tk-section-toggle:has-text("Development conversations")')) await unfold(page, 'Development conversations')
      await kp.click('[data-testid=ticket-chat]:has-text("MCP worktree fixture")')
      await kp.waitForSelector('.ai-msg.user:has-text("following its plan.")')
      assert((await kp.textContent('[data-testid=ai-role]')) === 'Development', 'the Assistant opens the linked development')
      const deadline = Date.now() + 10000
      while (!continueDevelopment && Date.now() < deadline) await page.waitForTimeout(50)
      assert(continueDevelopment, 'the default model received the first prompt')
      continueDevelopment()
      await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("from the ticket worktree")', { timeout: 15000 })
      const args = { cwd, id, chat }
      const transcript = await ok('kanban_conversation', { ...args, tools: true })
      assert(transcript.includes('Develop ticket #' + id) && transcript.includes('from the ticket worktree'), 'kanban_conversation returns the first prompt and the worktree result')
      assert(transcript.includes('the path is outside the ticket worktree'), 'the Assistant rejects reads outside the worktree')
      assert(fs.readFileSync(cwd + '/worktree-result.txt', 'utf8') === 'Written by the Assistant', 'the Assistant writes in the worktree')
      await ok('kanban_reply', { ...args, message: 'Check the output format' })
      await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Which format for this ticket?")')
      await kp.waitForSelector('[data-testid=send]')
      await ok('kanban_answer', { ...args, answers: [['CSV']] })
      await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("Development answer:"):has-text("CSV")', { timeout: 15000 })
      await kp.waitForSelector('[data-testid=send]')
      const acp = await mcp('agent_start', { cwd, id, provider: 'claude', message: 'Wait until later' }, sup)
      assert(!acp.result.isError, 'ACP can start after the Assistant turn: ' + mcpText(acp))
      const session = mcpText(acp).match(/Session (\w+) of/)?.[1]
      const busy = await mcp('kanban_develop', { cwd, id })
      assert(session && busy.result.isError && mcpText(busy).includes(session), 'the Assistant cannot start while ACP owns the development')

      // The ACP credential is issued by the pod as part of session/new.
      const data = process.env.E2E_DATA
      const project = JSON.parse(fs.readFileSync(data + '/projects.json', 'utf8')).find((p) => p.path === cwd)
      assert(project?.id, 'the worktree is registered')
      const credential = data + '/mcp-sessions/' + project.id + '/' + session
      const readyBy = Date.now() + 10000
      while (!fs.existsSync(credential) && Date.now() < readyBy) await page.waitForTimeout(30)
      assert(fs.existsSync(credential), 'ACP received its managed credential')
      const owner = fs.readFileSync(credential, 'utf8')
      const call = async (name, args) => JSON.parse(await ok(name, { cwd, ...args }, owner))
      const delegated = await call('assistant_start', { title: 'ACP fixture review', message: 'Check the ACP fixture' })
      const question = await call('assistant_wait', { chat: delegated.chat, turn: delegated.turn })
      assert(question.state === 'waiting_user' && question.question.includes('Which marker should I check?'), 'MCP reports the pending question')
      const delegations = await ok('assistant_list', { query: 'ACP fixture review', active: true }, observer)
      assert(delegations.includes(delegated.chat) && delegations.includes('ACP parent ' + session) && delegations.includes('state waiting_user'), 'Supervisor lists the delegation while it waits')
      const waiting = await ok('assistant_read', { cwd, chat: delegated.chat }, observer)
      assert(waiting.includes('turn ' + delegated.turn) && waiting.includes('Which marker should I check?'), 'Supervisor reads the waiting turn and its question')
      await page.goto(process.env.E2E_URL + '/project/' + project.parent + '?chat=' + encodeURIComponent(delegated.chat))
      await kp.waitForSelector('[data-testid=ai-ask-question]:has-text("Which marker should I check?")')
      const answer = await call('assistant_send', { chat: delegated.chat, message: 'Use the file marker' })
      const result = await call('assistant_wait', { chat: answer.chat, turn: answer.turn })
      assert(result.state === 'completed' && result.answer === 'ACP review finished.', 'MCP reports the delegated answer')
      await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("ACP review finished.")')
      const held = await call('assistant_send', { chat: delegated.chat, message: 'Hold this turn' })
      await kp.waitForSelector('.ai-msg.user:has-text("Hold this turn")')
      await call('assistant_send', { chat: delegated.chat, message: 'Queued message to discard' })
      await call('assistant_stop', { chat: held.chat, turn: held.turn })
      const stopped = await call('assistant_wait', { chat: held.chat, turn: held.turn })
      assert(stopped.state === 'cancelled', 'MCP reports the cancelled turn')
      await kp.waitForSelector('.ai-msg.assistant:has-text("Stopped.")')
      await kp.waitForSelector('.ai-msg.assistant:not(.live) .md:has-text("ACP review finished.")')
      assert(!(await kp.isVisible('.ai-msg.user:has-text("Queued message to discard")')), 'the stopped turn clears the queue and keeps the earlier result')
      const saved = await ok('assistant_read', { cwd, chat: delegated.chat }, observer)
      assert(saved.includes('turn ' + held.turn) && saved.includes('state cancelled') && saved.includes(result.answer), 'Supervisor reads the cancelled turn and the earlier result')
    }
  } finally {
    continueDevelopment?.()
    fake.close()
  }
})
