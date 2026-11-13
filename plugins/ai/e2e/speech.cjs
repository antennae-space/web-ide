// Local speech recognition: Whisper (tiny) in the browser, fed by a fake microphone playing
// e2e/audio/jfk.wav. Live dictation, then the dictation transcribed at the stop. Checks that the
// page only talks to the pod (the audio stays local) and that the model is cached by the pod.
const path = require('path')
const { run, openProject, assert, OUT, composerText } = require('../../../e2e/common.cjs')

const wav = path.join(__dirname, '../../../e2e/audio/jfk.wav')
const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`]

run(
  async ({ page }) => {
    const origin = new URL(process.env.E2E_URL).origin
    const outside = []
    const uploads = []
    page.on('request', (r) => {
      const u = r.url()
      if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) outside.push(u)
      else if (r.method() !== 'GET') uploads.push(`${r.method()} ${u}`)
    })
    await openProject(page)
    await page.click('.rail-right .rail-btn[title^="Assistant"]')
    await page.waitForSelector('.ai-panel')

    // Settings: smallest model, English.
    await page.click('[data-testid=assistant-settings]')
    await page.click('.ai-tab:has-text("Transcription")')
    await page.waitForSelector('[data-testid=speech-settings]')
    await page.selectOption('[data-testid=speech-settings] select[name=whisperModel]', 'tiny')
    await page.selectOption('[data-testid=speech-settings] select[name=whisperLang]', 'en')
    await page.click('.ai-servers .modal-head button')

    // Live dictation with the fake microphone (it plays the file in a loop): the words come into
    // the box while recording, dimmed until their segment is committed.
    const box = '.ai-composer .ed-content'
    await page.click('.ai-mic')
    await page.waitForSelector('[data-testid=ai-speech].rec')
    assert(true, 'recording shown')
    const early = await page
      .waitForFunction((b) => /country|fellow|americans|ask/i.test(document.querySelector(b).textContent), box, { timeout: 180000, polling: 250 })
      .then(() => true, () => false)
    const recording = await page.isVisible('[data-testid=ai-speech].rec')
    assert(early && recording, 'words typed in the box before the end of the dictation: ' + (await composerText(page)))
    await page.screenshot({ path: OUT + '/speech-live.png' })
    const live = await page
      .waitForFunction((b) => /ask not what.*can do for your country/i.test(document.querySelector(b).textContent), box, { timeout: 60000, polling: 500 })
      .then(() => true, () => false)
    assert(live && (await page.isVisible('[data-testid=ai-speech].rec')), 'the whole sentence typed while recording: ' + (await composerText(page)))
    await page.click('.ai-mic')
    await page.waitForSelector('[data-testid=ai-speech]', { state: 'detached', timeout: 60000 }).catch(() => {})
    assert(!(await page.isVisible('[data-testid=ai-speech]')), 'indicator removed after the dictation')
    assert(await page.evaluate(() => !CSS.highlights.get('ai-dictation')?.size), 'no provisional text left after the stop')
    // One undo takes back one committed segment, not a word nor the whole message.
    const dictated = await composerText(page)
    await page.focus(box)
    await page.keyboard.press('Control+z')
    const undone = await composerText(page)
    assert(undone.length < dictated.length && dictated.startsWith(undone.trim()), `one undo removes the last segment: "${dictated}" → "${undone}"`)

    // Live dictation off: the message is transcribed at the stop.
    await page.fill(box, '')
    await page.click('[data-testid=assistant-settings]')
    await page.click('.ai-tab:has-text("Transcription")')
    await page.uncheck('[data-testid=speech-settings] input[name=whisperLive]')
    await page.click('.ai-servers .modal-head button')
    await page.click('.ai-mic')
    await page.waitForSelector('[data-testid=ai-speech].rec')
    await page.waitForTimeout(11500)
    assert(!(await composerText(page)).trim(), 'nothing typed while recording when the live dictation is off')
    await page.click('.ai-mic')
    await page.waitForSelector('[data-testid=ai-speech]:not(.rec)', { timeout: 5000 }).catch(() => {})
    await page.screenshot({ path: OUT + '/speech-loading.png' })
    const ok = await page
      .waitForFunction((b) => /ask not what.*can do for your country/i.test(document.querySelector(b).textContent), box, { timeout: 180000, polling: 500 })
      .then(() => true, () => false)
    const text = await composerText(page)
    assert(ok, 'dictation transcribed into the message box: ' + text)
    await page.waitForSelector('[data-testid=ai-speech]', { state: 'detached', timeout: 5000 }).catch(() => {})
    assert(!(await page.isVisible('[data-testid=ai-speech]')), 'indicator removed after the transcription')

    // Audio file joined: transcribed in the page (the model is already loaded).
    await page.fill('.ai-composer .ed-content', '')
    await page.setInputFiles('.ai-composer input[type=file]', wav)
    await page.waitForSelector('.ai-composer .ai-att[title*="transcribed locally"]', { timeout: 60000 })
    assert(true, 'attached audio file transcribed locally')

    // The model is in the pod cache, listed in the settings.
    await page.click('[data-testid=assistant-settings]')
    await page.click('.ai-tab:has-text("Transcription")')
    await page.waitForSelector('[data-testid=speech-settings] .ai-server-row:has-text("onnx-community/whisper-tiny")', { timeout: 5000 }).catch(() => {})
    assert(await page.isVisible('[data-testid=speech-settings] .ai-server-row:has-text("onnx-community/whisper-tiny")'), 'model listed in the cache of the pod')
    await page.screenshot({ path: OUT + '/speech-settings.png' })
    await page.click('.ai-servers .modal-head button')

    // An agent session: the same dictation line above its box, the text in its box (#238).
    await page.click('.rail-btn[data-id=agents]')
    await page.click('[data-testid=agent-card-claude] button:has-text("Open")')
    await page.waitForSelector('[data-testid=agent-tab][data-state=ready]')
    await page.click('[data-testid=agent-composer] .ai-mic')
    await page.waitForSelector('[data-testid=agent-composer] [data-testid=ai-speech].rec')
    assert(true, 'the dictation line shows in an agent session')
    await page.waitForTimeout(11500)
    await page.click('[data-testid=agent-composer] .ai-mic')
    const agentOk = await page
      .waitForFunction(() => /ask not what.*can do for your country/i.test(document.querySelector('[data-testid=agent-input] .ed-content').textContent), null, { timeout: 120000, polling: 500 })
      .then(() => true, () => false)
    assert(agentOk, 'the dictation is transcribed into the box of the agent')

    assert(outside.length === 0, 'no request outside the pod: ' + JSON.stringify(outside.slice(0, 5)))
    assert(uploads.length === 0, 'no HTTP upload (the sound stays in the page): ' + JSON.stringify(uploads.slice(0, 5)))
  },
  { args, permissions: ['microphone'] },
)
