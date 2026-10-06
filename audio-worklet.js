class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffers = [];
    this.length = 0;
    this.targetSize = 2048;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'flush') {
        if (this.length) this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
      if (event.data?.type === 'reset') {
        this.buffers = [];
        this.length = 0;
      }
    };
  }

  process(inputs, outputs) {
    const channels = inputs[0] || [];
    let input = channels[0];
    if (input && channels.length > 1) {
      const mixed = new Float32Array(input.length);
      let strongest = input;
      let strongestEnergy = 0;
      for (const channel of channels) {
        let energy = 0;
        for (let index = 0; index < mixed.length; index += 1) {
          mixed[index] += (channel[index] || 0) / channels.length;
          energy += (channel[index] || 0) ** 2;
        }
        if (energy > strongestEnergy) { strongestEnergy = energy; strongest = channel; }
      }
      let mixedEnergy = 0;
      for (const sample of mixed) mixedEnergy += sample * sample;
      input = mixedEnergy < strongestEnergy * 0.25 ? strongest : mixed;
    }
    const output = outputs[0]?.[0];
    if (input) {
      const copy = new Float32Array(input);
      this.buffers.push(copy);
      this.length += copy.length;
      if (output) output.set(input.subarray(0, output.length));
      if (this.length >= this.targetSize) this.flush();
    } else if (output) {
      output.fill(0);
    }
    return true;
  }

  flush() {
    const merged = new Float32Array(this.length);
    let offset = 0;
    for (const buffer of this.buffers) {
      merged.set(buffer, offset);
      offset += buffer.length;
    }
    this.buffers = [];
    this.length = 0;
    this.port.postMessage(merged, [merged.buffer]);
  }
}

registerProcessor('bili-asr-capture', CaptureProcessor);
