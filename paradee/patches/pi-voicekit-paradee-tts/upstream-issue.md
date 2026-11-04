# Feature: add Paradee-8M as a local TTS model (Kokoro's af_heart, 9 MB, ~30x faster than Kokoro here)

Kokoro is the quality tier of pi-voicekit's catalog, but on x86 Windows it is
unusable for auto-speak: `kokoro-int8-en-v0_19` measures **RTF 2.2–5.1** on a
12-logical-core CPU (a 298-character reply takes 33.8 s to synthesize), and
`numThreads` barely helps (2.36 → 2.21 across 2..12 threads — the transformer
encoder does not scale). Kitten Nano is the only model that keeps up.

[Paradee](https://github.com/sahilmahendrakar/paradee) (Apache-2.0,
arXiv:2610.06817) is Kokoro's `af_heart` voice distilled to 8.07M parameters in
one **9 MB int8 ONNX** file. Measured here: **RTF 0.12 on one thread, 0.07 on
four** — the same 298-character reply in 1.4 s. Transcribing its output with
your own bundled Parakeet-v3 ASR gives **WER 5.6%** against the source text.
Upstream numbers: UTMOS 4.41 vs Kokoro 4.52, identical WER.

It cannot be a `kokoro` slot entry: the graph is
`input_ids` int64 `[1,T]` (misaki phoneme ids, `0` pads, ≤512 positions) +
`speed` float32 `[1]` → `waveform` float32 `[1,N]` @24 kHz, one voice baked in
(no `voices.bin`, no sid, and G2P must be **misaki**, not espeak-ng — raw
espeak phonemes give 31% WER vs 3%).

My first attempt at fixing it was wrong and worth naming: I primed
`onnxruntime-node` at import of `tts-paradee.ts`, reasoning that `tts-engine.ts`
imports it statically. But `voice.ts` loads 26 of its `./voice/*` modules with
`await import()`, so nothing TTS-related runs at extension load — `initSherpa()`
(voice.ts:3209, push-to-talk) still reached sherpa first in every session where
the microphone was used before the first spoken reply. Instrumenting the live
module and reading the log from a real `pi -p` run is what showed this: the prime
ran at `runSpeak` (voice.ts:3736 → speak.ts:25 → tts-engine.ts:49) with
`sherpa-onnx-node` already resident.

What works: prime it inside **`loadSherpa()`** — the single choke point through
which sherpa enters the process — immediately before the sherpa import:

```ts
try { await import("onnxruntime-node"); } catch { /* optional dep */ }
const ns = await import("sherpa-onnx-node");
```

~30 ms once per process, a no-op if the optional dependency is absent, and
`tts-paradee.ts` keeps its own import-time prime as the fallback for sessions
that speak before they listen. With that, both orders work: verified by running
real inference through both backends in one process after `initSherpa()` ran
first. If any other ONNX backend is ever added, it needs the same treatment — and
the error path should say "another ONNX Runtime is already loaded" rather than
"packages are not installed".

### One landmine worth documenting (found while integrating)

`sherpa-onnx-node` and `onnxruntime-node` each bundle their own ONNX Runtime, and
**only one of them can be loaded first**. If sherpa is already resident, Windows
refuses the other package's native binding outright:

```
Error: Speak failed: Paradee needs the `onnxruntime-node` and `phonemizer`
packages, which are not installed (The operating system cannot run %1.
\?\C:\Users\…\onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime_binding.node)
```

Both packages are installed — the message is misleading, and the failure is
total for the session. Load order is the only variable: sherpa→ORT is fatal,
ORT→sherpa is fine (verified: real inference on both backends in one process).
Since `sherpa-loader.ts` dlopens sherpa on first STT/punctuation use, a lazily
loaded second backend loses that race in most sessions — see the fix at the top of
this issue.
