// Audio worklet: hands raw microphone samples to the hands-free listener in
// ~40 ms batches (the audio thread delivers 128 samples at a time). When the input
// is silent or disconnected, Chrome hands over no channels at all; zeros are sent
// instead so the listener's clock keeps running and can notice you stopped talking.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.silence = new Float32Array(128);
  }

  process(inputs) {
    const ch = (inputs[0] && inputs[0][0]) || this.silence;
    if (this.n + ch.length > this.buf.length) {
      this.port.postMessage(this.buf.slice(0, this.n));
      this.n = 0;
    }
    this.buf.set(ch, this.n);
    this.n += ch.length;
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
