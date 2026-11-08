# pi-voicekit patch: Paradee-8M TTS backend

**Adds Paradee (https://github.com/sahilmahendrakar/paradee) as a local TTS
model — in v1.2, four of Kokoro's voices (`af_heart`, `bf_isabella`, `am_puck`,
`bm_fable`) distilled to 8.07M parameters in one 8.5 MB int8 ONNX file, with a
scalar int64 `voice` input that picks the speaker.** Apache-2.0.

## Measured on this machine (Windows/x64, 12 logical CPUs)

| model | RTF 1 thread | RTF 4 threads | 298-char reply | disk |
|---|---|---|---|---|
| `kokoro-int8-en-v0_19` (was configured) | 2.2 | 2.2 | **33.8 s** | 152 MB |
| `kitten-nano-en-v0_2` (catalog default) | 0.48 | — | ~12 s | 41 MB |
| **`paradee-8m-v1_0` (this patch)** | **0.12** | **0.07** | **1.4 s** | 8.7 MB |

Through the patched `synthesize()` (self-test): cold 3.9 s including the
one-time ONNX session load, then **warm RTF 0.086 — 8.65 s of audio in 743 ms**.
Objective intelligibility, transcribing Paradee's own output with the local
Parakeet-v3 ASR: **WER 5.6 %** over 54 words (misses were "DirectShow" →
"direct show" and punctuation placement only). Upstream's own numbers: UTMOS
4.41 vs Kokoro's 4.52, identical WER.

## Why a new backend instead of a new model entry

sherpa-onnx's `kokoro` slot takes **text**, phonemizes internally with
`espeak-ng-data`, and mixes a `voices.bin` speaker embedding. Paradee's graph is
`input_ids` (int64 `[1,T]` misaki phoneme ids, `0` pad at both ends, ≤512
positions) + `speed` (float32 `[1]`) → `waveform` (float32 `[1, N]` @24 kHz), and
in v1.2 a scalar int64 `voice` input (`[1]`) selects the speaker. It cannot be expressed as an `OfflineTts` slot, so
`extensions/voice/tts-paradee.ts` drives `onnxruntime-node` directly.

G2P: `phonemizer` (eSpeak NG compiled to wasm — the same package kokoro-js
depends on) → `toMisaki()` (vendored from upstream `web/misaki.js`,
Apache-2.0). That conversion is **not** optional: fed raw eSpeak phonemes the
model mumbles (upstream: Whisper WER 31 % → 3 %). We also keep sentence
punctuation aside and re-insert it, because eSpeak-based phonemizers drop it
while Paradee's vocabulary has prosody ids for it.

## What the patch touches

- `extensions/voice/sherpa-loader.ts` — primes `onnxruntime-node` immediately
  before the sherpa import: the only place that can guarantee the load order (see
  *Load-order constraint*). **This hunk is what actually fixed the live failure.**
- `extensions/voice/tts-paradee.ts` — new backend (session cache, chunking to
  the 510-phoneme window, abort wiring, NaN guard), plus its own import-time
  `primeOnnxRuntime()` fallback so speaking before listening also works.
- `extensions/voice/tts-local-models.ts` — `backend?: "sherpa" | "paradee"` +
  `files?: TtsModelFile[]` (multi-file Hugging Face installs: download →
  optional SHA-256 verify → atomic rename; no tar), `isTtsModelInstalled()`
  checks `files[]` instead of `tokens.txt`, catalog entry `paradee-8m-v1_0`
  with the model hash pinned `60e8f8a1…98eb`.
- `extensions/voice/tts-engine.ts` — dispatch in `synthesize()` (before the
  sherpa loader), `warmupTts()` routes to `preloadParadee()`,
  `clearTtsCache()` releases ONNX sessions.
- `package.json` — `onnxruntime-node ^1.30.0` + `phonemizer ^1.2.1` as optional
  deps.

## Apply / re-apply

```bash
bash ~/.pi/agent/patches/pi-voicekit-paradee-tts/apply.sh
```
Idempotent (greps `paradee` in `tts-engine.ts`), re-syncs `tts-paradee.ts` from
`fixed/` if the deployed copy drifted, installs missing npm deps, then runs
`test_paradee.mjs` and `test_load_order.mjs`. pi-voicekit lives in
`node_modules`, so **pi-auto-update wipes this on the next version bump** —
re-run after every bump (order with the other patches does not matter; this one
touches `tts-engine.ts`, `tts-local-models.ts` and `package.json` only).

Configured in `~/.pi/agent/settings.json` → `voice`:
`"ttsLocalModel": "paradee-8m-v1_0"`, `"ttsLocalVoiceId": 0`.

## Load-order constraint (this bit us live)

`sherpa-onnx-node` and `onnxruntime-node` each ship their own ONNX Runtime. Once
sherpa's copy is resident, the Windows loader **refuses** `onnxruntime-node`'s
native binding:

```
Error: Speak failed: Paradee needs the `onnxruntime-node` and `phonemizer`
packages, which are not installed (The operating system cannot run %1.
\??\C:\Users\…\onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime_binding.node)
```

The packages were installed; load order was the only variable:

| order | result |
|---|---|
| sherpa → onnxruntime-node | **fatal** (binding refused, dead TTS for the whole session) |
| onnxruntime-node → sherpa | both fine, real inference on both backends |

A lazily-loaded Paradee backend loses that race in any session where the **mic
was used before the first spoken reply** — instrumented proof from a real pi
process shows the prime runs at `runSpeak` (voice.ts:3736 → speak.ts:25 →
tts-engine.ts:49), and `sherpa-onnx-node` is already resident by then if STT ran
first. `voice.ts` loads its `./voice/*` modules with `await import()` (26 of
them), so no entry-level import can win the order.

The fix therefore sits at the **choke point**: `loadSherpa()` — the only way
sherpa enters the process — first does
`try { await import("onnxruntime-node"); } catch {}` (~30 ms, once, no-op if the
optional dep is absent) and only then imports sherpa. `tts-paradee.ts` keeps its
module-level prime as the fallback for sessions that speak before listening.
Either order now works: `test_load_order.mjs` runs `initSherpa()` first (TTS
modules untouched) and asserts `onnxruntime-node` is resident afterwards, then
runs **real inference on both backends** in one process — PASS. Child
`ROLE=raw-sherpa` bypasses `loadSherpa()` with a raw `require()` and must get the
explanatory error, not "packages are not installed".

**Consequence for any future second ONNX backend: it must be resident before
`loadSherpa()` imports sherpa, or the OS will refuse its binding.**
The reverse order is exercised in a child process and must produce the
explanatory error, not "packages are not installed".

**Consequence for any future second ONNX backend: prime it before sherpa, or it
will not load at all.**

## Known gap

`warmupTts()`/`initTts()` are exported by `tts-engine.ts` but **never called by
`voice.ts`** (upstream gap, pre-existing), so the first utterance of a session
pays the ~3 s ONNX session load; everything after that is the warm number.
