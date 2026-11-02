// Live dictation: hands the microphone samples (mono, rate of the audio context) to the page.
// Plain JavaScript loaded as a file of the app (a blob: module would break the relay's CSP).
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(2048)
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0]?.[0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer])
        this.buf = new Float32Array(2048)
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
