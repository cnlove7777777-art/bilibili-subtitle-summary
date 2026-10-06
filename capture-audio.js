'use strict';

// A scan captures audio with preservesPitch=false. Its samples represent media
// time at inputRate / playbackRate, so restore time and pitch BEFORE reducing to
// 16 kHz. Fractional phase and the boundary sample survive callback boundaries.
// This cannot recover frequencies already removed by the browser's audio path.
(() => {
  function createResampler(inputRate, playbackRate = 1, outputRate = 16000) {
    if (![inputRate, playbackRate, outputRate].every(value => Number.isFinite(value) && value > 0) || playbackRate > 8) {
      throw new Error('音频采样率或恢复倍速无效');
    }
    const step = inputRate / playbackRate / outputRate;
    let carry = new Float32Array(0), position = 0, received = 0, produced = 0, ended = false;
    function process(input, final = false) {
      if (ended) return new Float32Array(0);
      const data = new Float32Array(carry.length + input.length);
      data.set(carry); data.set(input, carry.length);
      received += input.length;
      const maximum = Math.max(0, Math.floor(received / step + 1e-7) - produced);
      const output = new Float32Array(maximum);
      let length = 0;
      while (length < maximum) {
        if (!final && position + Math.max(1, step) > data.length) break;
        const start = Math.floor(position);
        if (step < 1) {
          const left = data[Math.min(start, data.length - 1)] || 0;
          const right = data[Math.min(start + 1, data.length - 1)] || 0;
          output[length] = left + (right - left) * (position - start);
        } else {
          // Integrate a fractional sample interval when downsampling. This
          // avoids phase drift and alias-prone nearest-neighbour decimation.
          const end = position + step;
          let sum = 0;
          for (let index = start; index < Math.ceil(end); index++) {
            const weight = Math.min(index + 1, end) - Math.max(index, position);
            sum += (data[Math.min(index, data.length - 1)] || 0) * weight;
          }
          output[length] = sum / step;
        }
        length++; position += step;
      }
      produced += length;
      const consumed = Math.min(data.length, Math.floor(position));
      carry = data.slice(consumed);
      position -= consumed;
      if (final) { carry = new Float32Array(0); ended = true; }
      return length === output.length ? output : output.slice(0, length);
    }
    return Object.freeze({ process: input => process(input), flush: () => process(new Float32Array(0), true) });
  }
  globalThis.BscgCaptureAudio = Object.freeze({ createResampler });
})();
