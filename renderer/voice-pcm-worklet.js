/* global AudioWorkletProcessor, registerProcessor */
class VoicePCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(4096); this.offset = 0; this.recording = true;
    this.port.onmessage = event => {
      if (event.data === 'flush') { this.recording = false; this.flush(); this.port.postMessage({ flushed: true }); }
    };
  }
  flush() {
    if (!this.offset) return;
    const buffer = new ArrayBuffer(this.offset * 2);
    const view = new DataView(buffer);
    let peak = 0;
    for (let i = 0; i < this.offset; i++) { view.setInt16(i * 2, this.samples[i], true); peak = Math.max(peak, Math.abs(this.samples[i]) / 32768); }
    this.port.postMessage({ pcm: buffer, peak }, [buffer]); this.offset = 0;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples && this.recording) {
      for (const sample of samples) {
        const value = Math.max(-1, Math.min(1, sample));
        this.samples[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
        if (this.offset === this.samples.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('hub-voice-pcm', VoicePCM);
