# 0.16.24

GitHub public release cleanup and project rebranding.

## Changes

- Rename the public-facing extension to **全网视频实时字幕与总结 · 浏览器识别 / Browser Live Captions & Summary**.
- Add public README, MIT license, CI verification and reproducible ONNX Runtime restore script.
- Exclude WorkBuddy development memories and local-only benchmark credentials/paths from the public repository.
- Keep the runtime behavior and recognition pipeline unchanged from 0.16.23.

## Verification

```bash
node tests/verify.mjs
node tests/ui-summary-regressions.mjs
node tests/model-bootstrap.mjs
node tests/scan-audio.mjs
```

Expected result: **87/87 checks pass**. Real WebGPU performance, site compatibility and tab-audio behavior still require browser/hardware acceptance testing.
