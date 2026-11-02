// Speech to text in the browser (Whisper in a worker). Recording, decoding and recognition
// all happen in the page: the audio is never sent anywhere. The model files are downloaded
// once through the pod (cache in ~/.web-ide/models).
import { createStore } from 'solid-js/store'
// By path: the package exports do not list these files.
import ortMjs from '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url'
// A file, never inlined: addModule of a data: URL breaks the relay's CSP (script-src 'self').
import pcmWorklet from './pcm-worklet.js?url&no-inline'
import { prefs } from './state'
import { podPath, t, toast } from '../plugin'

export interface WhisperModel {
  id: string
  label: string
  repo: string
  /** Download size per device. */
  /** Approximate download size in MB (0: not available). */
  size: { webgpu: number; wasm: number }
  dtype: { webgpu: any; wasm: any }
  /** Needs WebGPU with 16-bit floats (too slow otherwise). */
  webgpuOnly?: boolean
}

export const whisperModels: WhisperModel[] = [
  { id: 'tiny', label: 'Tiny (fast, rough)', repo: 'onnx-community/whisper-tiny', size: { webgpu: 41, wasm: 41 }, dtype: { webgpu: 'q8', wasm: 'q8' } },
  { id: 'base', label: 'Base', repo: 'onnx-community/whisper-base', size: { webgpu: 77, wasm: 77 }, dtype: { webgpu: 'q8', wasm: 'q8' } },
  { id: 'small', label: 'Small (better, slower)', repo: 'onnx-community/whisper-small', size: { webgpu: 250, wasm: 250 }, dtype: { webgpu: 'q8', wasm: 'q8' } },
  {
    id: 'turbo',
    label: 'Large v3 Turbo (the best, WebGPU)',
    repo: 'onnx-community/whisper-large-v3-turbo',
    size: { webgpu: 560, wasm: 0 },
    dtype: { webgpu: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' }, wasm: null },
    webgpuOnly: true,
  },
]

export const languages: [string, string][] = [
  ['auto', 'Automatic detection'],
  ['fr', 'French'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
]

export const [speech, setSpeech] = createStore({
  phase: 'idle' as 'idle' | 'recording' | 'loading' | 'transcribing',
  loaded: 0,
  total: 0,
  startedAt: 0,
  /** Live dictation: the model is being loaded while recording. */
  modelLoading: false,
  device: '' as '' | 'webgpu' | 'wasm',
  f16: false,
})

let gpuProbe: Promise<{ webgpu: boolean; f16: boolean }> | null = null
export function probeGpu() {
  gpuProbe ??= (async () => {
    try {
      const adapter = await (navigator as any).gpu?.requestAdapter()
      const r = { webgpu: !!adapter, f16: !!adapter?.features?.has('shader-f16') }
      setSpeech({ device: r.webgpu ? 'webgpu' : 'wasm', f16: r.f16 })
      return r
    } catch {
      setSpeech({ device: 'wasm', f16: false })
      return { webgpu: false, f16: false }
    }
  })()
  return gpuProbe
}

export function modelById(id: string) {
  return whisperModels.find((m) => m.id === id) ?? whisperModels[1]
}

let worker: Worker | null = null
let seq = 0
const waiting = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
  const abs = (u: string) => new URL(u, location.href).href
  worker.postMessage({ type: 'config', remoteHost: `${location.origin}${podPath('/models/hf/')}`, wasm: { mjs: abs(ortMjs), wasm: abs(ortWasm) } })
  worker.onmessage = (e) => {
    const m = e.data
    if (m.type === 'progress') setSpeech({ loaded: m.loaded, total: m.total })
    else if (m.type === 'phase') {
      // A live pass keeps the recording phase (the microphone stays clickable).
      if (live && speech.phase === 'recording') setSpeech({ modelLoading: m.phase === 'loading' })
      else setSpeech({ phase: m.phase, ...(m.phase === 'transcribing' ? { loaded: 0, total: 0 } : {}) })
    } else if (m.type === 'done') {
      waiting.get(m.id)?.resolve(m.text)
      waiting.delete(m.id)
    } else if (m.type === 'error') {
      waiting.get(m.id)?.reject(new Error(m.message))
      waiting.delete(m.id)
    }
  }
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.reject(new Error(e.message || t('transcription engine error')))
    waiting.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

/** Audio of any file the browser can decode, as 16 kHz mono samples. */
async function decode(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: 16000 })
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice()
    const out = new Float32Array(buf.length)
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c)
      for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels
    }
    return out
  } catch {
    throw new Error(t('audio the browser cannot read'))
  } finally {
    ctx.close()
  }
}

function run(audio: Float32Array, repo: string, dtype: any, device: 'webgpu' | 'wasm', live: boolean): Promise<string> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    getWorker().postMessage({ type: 'transcribe', id, repo, dtype, device, audio, language: prefs.whisperLang, live }, [audio.buffer])
  })
}

let queue: Promise<unknown> = Promise.resolve()

/** Runs the recognitions one after the other (the worker holds one model). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const job = queue.then(fn)
  queue = job.catch(() => {})
  return job
}

/** 16 kHz samples to text with the chosen model (WebGPU, else WebAssembly); an empty audio only loads the model. Live: under 30 s, in one window. */
async function recognize(audio: Float32Array, live = false): Promise<{ text: string; device: 'webgpu' | 'wasm' }> {
  const gpu = await probeGpu()
  let model = modelById(prefs.whisperModel)
  if (model.webgpuOnly && !(gpu.webgpu && gpu.f16)) model = modelById('small')
  if (gpu.webgpu) {
    try {
      return { text: await run(audio.slice(), model.repo, model.dtype.webgpu, 'webgpu', live), device: 'webgpu' }
    } catch (e) {
      if (model.webgpuOnly) throw e
      console.warn('WebGPU not available for the transcription, falling back to WebAssembly:', e)
    }
  }
  return { text: await run(audio, model.repo, model.dtype.wasm, 'wasm', live), device: 'wasm' }
}

/** Transcribes an audio (or video) file. Requests run one after the other. */
export function transcribe(blob: Blob): Promise<string> {
  return serial(async () => {
    setSpeech({ phase: 'loading', loaded: 0, total: 0 })
    try {
      const audio = await decode(blob)
      if (!audio.length) return ''
      return (await recognize(audio)).text
    } finally {
      setSpeech({ phase: 'idle', loaded: 0, total: 0 })
    }
  })
}

// ---------- microphone ----------

let recorder: MediaRecorder | null = null
let chunks: Blob[] = []

export function canRecord() {
  return !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
}

function microphone() {
  if (!canRecord()) throw new Error(window.isSecureContext ? t('microphone not available in this browser') : t('the microphone requires https or localhost'))
  return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
}

async function startRecording() {
  if (recorder) return
  const stream = await microphone()
  chunks = []
  recorder = new MediaRecorder(stream)
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  recorder.start(250)
  setSpeech({ phase: 'recording', startedAt: Date.now() })
}

/** Stops the recording and returns its audio (null when nothing was recorded). */
function stopRecording(): Promise<Blob | null> {
  const r = recorder
  if (!r) return Promise.resolve(null)
  recorder = null
  return new Promise((resolve) => {
    r.onstop = () => {
      r.stream.getTracks().forEach((t) => t.stop())
      setSpeech({ phase: 'idle' })
      resolve(chunks.length ? new Blob(chunks, { type: r.mimeType }) : null)
    }
    r.stop()
  })
}


// ---------- dictation ----------
// Live (prefs.whisperLive): the microphone goes through an AudioWorklet into an open segment.
// While the user speaks, the segment is transcribed again each time the previous pass ends (once
// 0.5 s more has come) and shown as provisional text; a pause, or 20 s, commits it and opens the
// next one. Otherwise the whole message is recorded and transcribed at the stop.

/** Where the dictated text goes (the message box: liveDictation in MessageBox.tsx). */
export interface DictationSink {
  /** The provisional text of the open segment, in place of the previous one. */
  partial(text: string): void
  /** The final text of the segment (empty: nothing said); the next segment follows it. */
  commit(text: string): void
  /** The dictation is over (stopped or dropped). */
  end(): void
}

const RATE = 16000
const FRAME = 480 // 30 ms
const PAUSE = 0.7 * RATE
const STEP = 0.5 * RATE
const MAX_SEGMENT = 20 * RATE
const PRE_ROLL = 0.3 * RATE
/** A live pass slower than this on the processor: the rest of the message is transcribed at the stop. */
const SLOW_MS = 3000

interface Live {
  sink: DictationSink
  stream: MediaStream
  ctx: AudioContext
  /** Samples of the open segment (16 kHz). */
  seg: Float32Array
  len: number
  /** Length of the segment at its last pass, and end of the frames read by the VAD. */
  passedAt: number
  vadAt: number
  voiced: boolean
  /** Samples since the last voiced frame, and the noise level. */
  silence: number
  floor: number
  /** The model is loaded: a slow pass is the engine's, not the download's. */
  ready: boolean
  busy: boolean
  slow: boolean
  stopped: boolean
}

let live: Live | null = null
let recordSink: DictationSink | null = null

/** Starts a dictation into the sink; ends with stopDictation (the last words) or cancelDictation. */
export async function startDictation(sink: DictationSink) {
  if (live || recorder) return
  if (!prefs.whisperLive) {
    await startRecording()
    recordSink = sink
    return
  }
  const stream = await microphone()
  const ctx = new AudioContext()
  try {
    await ctx.audioWorklet.addModule(new URL(pcmWorklet, location.href).href)
  } catch (e) {
    stream.getTracks().forEach((tr) => tr.stop())
    ctx.close()
    throw e
  }
  // No output: the node only reads the microphone.
  const node = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfOutputs: 0 })
  ctx.createMediaStreamSource(stream).connect(node)
  const l: Live = { sink, stream, ctx, seg: new Float32Array(RATE * 4), len: 0, passedAt: 0, vadAt: 0, voiced: false, silence: 0, floor: 0, ready: false, busy: false, slow: false, stopped: false }
  const resample = resampler(ctx.sampleRate)
  node.port.onmessage = (e) => feed(l, resample(e.data))
  live = l
  setSpeech({ phase: 'recording', startedAt: Date.now(), modelLoading: false })
  // The model loads while the first words are said.
  serial(() => recognize(new Float32Array(0), true)).then(
    () => (l.ready = true),
    (e) => fail(l, e),
  )
}

/** Ends the dictation: the last segment is transcribed and committed. */
export async function stopDictation() {
  if (recorder) {
    const sink = recordSink
    recordSink = null
    try {
      const blob = await stopRecording()
      if (blob && sink) sink.commit(await transcribe(blob))
    } finally {
      sink?.end()
    }
    return
  }
  const l = live
  if (!l) return
  release(l)
  setSpeech({ phase: 'transcribing', modelLoading: false })
  try {
    while (l.busy) await new Promise((r) => setTimeout(r, 50))
    if (l.voiced && live === l) await pass(l, true)
  } finally {
    if (live === l) {
      live = null
      setSpeech({ phase: 'idle', loaded: 0, total: 0 })
    }
    l.sink.end()
  }
}

/** Drops the dictation (the box closed): nothing more is written. */
export function cancelDictation() {
  recordSink?.end()
  recordSink = null
  stopRecording().catch(() => {})
  const l = live
  if (!l) return
  live = null
  release(l)
  l.sink.end()
  setSpeech({ phase: 'idle', modelLoading: false, loaded: 0, total: 0 })
}

function release(l: Live) {
  if (l.stopped) return
  l.stopped = true
  l.stream.getTracks().forEach((tr) => tr.stop())
  l.ctx.close().catch(() => {})
}

function fail(l: Live, e: unknown) {
  if (live !== l) return
  cancelDictation()
  toast(t('Dictation: {message}', { message: (e as Error)?.message ?? String(e) }), 'error')
}

/** Mono samples at the rate of the audio context to 16 kHz (mean of the samples of each step). */
function resampler(from: number) {
  const ratio = from / RATE
  let acc = 0
  let n = 0
  let at = 0
  let next = ratio
  return (inp: Float32Array) => {
    if (ratio === 1) return inp
    const out = new Float32Array(Math.ceil(inp.length / ratio) + 2)
    let k = 0
    for (let i = 0; i < inp.length; i++) {
      acc += inp[i]
      n++
      at++
      if (at >= next) {
        const v = acc / n
        acc = 0
        n = 0
        while (at >= next) {
          out[k++] = v
          next += ratio
        }
      }
    }
    return out.subarray(0, k)
  }
}

function feed(l: Live, chunk: Float32Array) {
  if (l.stopped) return
  if (l.len + chunk.length > l.seg.length) {
    const bigger = new Float32Array(Math.max(l.seg.length * 2, l.len + chunk.length))
    bigger.set(l.seg.subarray(0, l.len))
    l.seg = bigger
  }
  l.seg.set(chunk, l.len)
  l.len += chunk.length
  // Voice activity: the energy of each 30 ms frame against the noise level.
  for (; l.vadAt + FRAME <= l.len; l.vadAt += FRAME) {
    let e = 0
    for (let i = l.vadAt; i < l.vadAt + FRAME; i++) e += l.seg[i] * l.seg[i]
    const rms = Math.sqrt(e / FRAME)
    if (rms > Math.max(0.01, l.floor * 3)) {
      l.voiced = true
      l.silence = 0
      l.floor = l.floor * 0.999 + rms * 0.001
    } else {
      l.silence += FRAME
      l.floor = l.floor ? l.floor * 0.95 + rms * 0.05 : rms
    }
  }
  // Before any word, only the last moment is kept (the start of the first one).
  if (!l.voiced && l.len > PRE_ROLL) drop(l, l.len - PRE_ROLL)
  pump(l)
}

function drop(l: Live, n: number) {
  l.seg.copyWithin(0, n, l.len)
  l.len -= n
  l.vadAt = Math.max(0, l.vadAt - n)
  l.passedAt = 0
}

function pump(l: Live) {
  if (l.busy || l.stopped || l.slow || !l.voiced) return
  if (l.silence >= PAUSE || l.len >= MAX_SEGMENT) void pass(l, true)
  else if (l.len - l.passedAt >= STEP) void pass(l, false)
}

/** One recognition of the open segment: provisional, or final (the segment is closed). */
async function pass(l: Live, final: boolean) {
  const audio = l.seg.slice(0, l.len)
  if (final) {
    // After a pause the next segment keeps its end (the start of the next word); after 20 s, nothing.
    const pause = l.silence >= PAUSE
    drop(l, pause ? Math.max(0, l.len - PRE_ROLL) : l.len)
    l.voiced = false
    l.silence = 0
  } else l.passedAt = l.len
  l.busy = true
  try {
    const r = await serial(async () => {
      const t0 = performance.now()
      return { ...(await recognize(audio, audio.length <= 30 * RATE)), ms: performance.now() - t0 }
    })
    if (live !== l) return
    const text = clean(r.text)
    if (final) l.sink.commit(text)
    else if (!l.stopped) {
      l.sink.partial(text)
      if (l.ready && r.device === 'wasm' && r.ms > SLOW_MS && !l.slow) {
        l.slow = true
        toast(t('Live dictation is too slow on this device: the rest is transcribed when you stop.'), 'info')
      }
    }
  } catch (e) {
    fail(l, e)
  } finally {
    l.busy = false
    pump(l)
  }
}

/** What Whisper says over noise or silence. */
const filler = /^(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+)$|^(sous-titr|subtitles by)|amara\.org/i

function clean(s: string) {
  s = s.trim()
  return filler.test(s) ? '' : s
}
