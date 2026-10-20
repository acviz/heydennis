# Third-party notices and credits

## Adapted code

**holo-gestures** by Zubair Trabzada / AI Workshop Studio LLC, MIT License.
https://github.com/zubair-trabzada/holo-gestures

`ui/js/hands.js` adapts its gesture techniques and several tuned constants: pinch thresholds with hysteresis and an earn gate, One Euro cursor smoothing, nearest-palm hand-slot assignment, ghost-hand dedupe, the quick-tap gate, reach amplification, held peace and fist poses, and the synthetic-hand generator used by `?sim` and `?probe`. `scripts/vendor.mjs` applies the same one-line `dbg()` shim to MediaPipe's wasm glue that holo-gestures documents.

> MIT License. Copyright (c) 2026 Zubair Trabzada / AI Workshop Studio LLC. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

## Inspiration (no code copied)

**fullstack-agent** by Jared Rhodenizer (AGPL-3.0). https://github.com/jaredrhod/fullstack-agent

Its idea of an agent with a mind, a voice, a face and hands shaped D.E.N.N.I.S.'s design. No source from it or its component repositories is included here.

## Bundled libraries (copied into `ui/vendor/` at install time)

| Library | License | Use |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | MIT | 3D galaxy |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) + Hand Landmarker model | Apache-2.0 | Hand tracking |
| [transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 | Local speech recognition |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | MIT | Runs the speech model |
| [Whisper](https://github.com/openai/whisper) models (downloaded on first use, ONNX conversions by Xenova) | MIT | Speech-to-text |

## Runtime dependencies

| Package | License |
|---|---|
| [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | MIT |
| [Electron](https://github.com/electron/electron) | MIT |
