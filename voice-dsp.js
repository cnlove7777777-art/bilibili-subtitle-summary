'use strict';

// Lightweight, model-free speech conditioning for ASR input only.
// The chain is intentionally conservative: high-pass -> soft downward
// expander -> adaptive gain -> peak limiter. It never changes timing.
(function exposeVoiceDsp(globalScope) {
  const PRESETS = Object.freeze({
    gentle: Object.freeze({
      label: '轻度', highPassHz: 70, floorGain: 0.55,
      targetRms: 0.065, maxGainDb: 6, openRatio: 3.0
    }),
    balanced: Object.freeze({
      label: '平衡', highPassHz: 90, floorGain: 0.32,
      targetRms: 0.080, maxGainDb: 10, openRatio: 3.4
    }),
    strong: Object.freeze({
      label: '强', highPassHz: 120, floorGain: 0.18,
      targetRms: 0.090, maxGainDb: 12, openRatio: 4.0
    })
  });

  function resolvePreset(value) {
    return PRESETS[value] || PRESETS.balanced;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function smoothStep(value) {
    const normalized = clamp(value, 0, 1);
    return normalized * normalized * (3 - 2 * normalized);
  }

  function createProcessor(sampleRate = 16000, presetName = 'balanced') {
    const rate = clamp(Number(sampleRate) || 16000, 8000, 192000);
    const name = PRESETS[presetName] ? presetName : 'balanced';
    const preset = resolvePreset(name);
    const rc = 1 / (2 * Math.PI * preset.highPassHz);
    const dt = 1 / rate;
    return {
      sampleRate: rate,
      presetName: name,
      preset,
      frameSize: Math.max(32, Math.round(rate * 0.01)),
      highPassAlpha: rc / (rc + dt),
      previousInput: 0,
      previousHighPass: 0,
      noiseFloor: 0.004,
      noiseReady: false,
      gateGain: 1,
      levelGain: 1,
      processedSamples: 0,
      limitedSamples: 0
    };
  }

  function processVoiceChunk(processor, input) {
    if (!processor || !input?.length) return input instanceof Float32Array ? input.slice() : new Float32Array(0);
    const source = input instanceof Float32Array ? input : Float32Array.from(input);
    const output = new Float32Array(source.length);
    const preset = processor.preset;
    const maxGain = 10 ** (preset.maxGainDb / 20);
    const limiter = 0.98;

    for (let frameStart = 0; frameStart < source.length; frameStart += processor.frameSize) {
      const frameEnd = Math.min(source.length, frameStart + processor.frameSize);
      let energy = 0;
      let peak = 0;

      for (let index = frameStart; index < frameEnd; index += 1) {
        const sample = Number.isFinite(source[index]) ? source[index] : 0;
        const filtered = processor.highPassAlpha * (
          processor.previousHighPass + sample - processor.previousInput
        );
        processor.previousInput = sample;
        processor.previousHighPass = filtered;
        output[index] = filtered;
        energy += filtered * filtered;
        peak = Math.max(peak, Math.abs(filtered));
      }

      const frameLength = Math.max(1, frameEnd - frameStart);
      const rms = Math.sqrt(energy / frameLength);
      if (!processor.noiseReady) {
        processor.noiseFloor = clamp(rms * 0.72, 0.001, 0.018);
        processor.noiseReady = true;
      } else if (rms < processor.noiseFloor) {
        processor.noiseFloor = processor.noiseFloor * 0.86 + rms * 0.14;
      } else if (rms < processor.noiseFloor * 1.9) {
        processor.noiseFloor = processor.noiseFloor * 0.985 + rms * 0.015;
      } else {
        processor.noiseFloor = Math.min(0.03, processor.noiseFloor * 1.00035);
      }
      processor.noiseFloor = clamp(processor.noiseFloor, 0.00025, 0.03);

      const ratio = rms / Math.max(0.00025, processor.noiseFloor);
      const gatePosition = (ratio - 1.15) / Math.max(0.1, preset.openRatio - 1.15);
      const desiredGate = preset.floorGain + (1 - preset.floorGain) * smoothStep(gatePosition);
      const gateRate = desiredGate > processor.gateGain ? 0.45 : 0.08;
      const previousGate = processor.gateGain;
      processor.gateGain += (desiredGate - processor.gateGain) * gateRate;

      let desiredLevel = 1;
      if (ratio > 1.35 && rms > 0.0005) {
        desiredLevel = clamp(preset.targetRms / rms, 0.72, maxGain);
        if (peak > 0) desiredLevel = Math.min(desiredLevel, limiter / (peak * Math.max(0.35, processor.gateGain)));
      }
      const levelRate = desiredLevel < processor.levelGain ? 0.55 : 0.055;
      const previousLevel = processor.levelGain;
      processor.levelGain += (desiredLevel - processor.levelGain) * levelRate;

      for (let index = frameStart; index < frameEnd; index += 1) {
        const progress = (index - frameStart + 1) / frameLength;
        const gate = previousGate + (processor.gateGain - previousGate) * progress;
        const level = previousLevel + (processor.levelGain - previousLevel) * progress;
        let sample = output[index] * gate * level;
        if (sample > limiter) {
          sample = limiter;
          processor.limitedSamples += 1;
        } else if (sample < -limiter) {
          sample = -limiter;
          processor.limitedSamples += 1;
        }
        output[index] = sample;
      }
      processor.processedSamples += frameLength;
    }
    return output;
  }

  const api = Object.freeze({ PRESETS, createProcessor, processVoiceChunk });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.BscgVoiceDsp = api;
})(typeof self !== 'undefined' ? self : globalThis);
