# Paradee voice for pi

**This fork of [pi-voicekit](https://github.com/CyFeng16/pi-voicekit) makes the Pi coding agent speak
its replies with [Paradee-8M](https://github.com/sahilmahendrakar/paradee)** — Kokoro's `af_heart`
voice distilled to 8.07M parameters in one 9 MB int8 ONNX file — and fixes the seven things that stood
between that model and a usable voice.

Fork base: pi-voicekit **v0.4.2** (MIT), pinned deliberately; see [Why a fork](#why-a-fork).
Upstream is untouched and this tree differs from `v0.4.2` by exactly eight commits.

```
extensions/voice/tts-paradee.ts   the backend: phonemize → misaki ids → onnxruntime → 24 kHz PCM
extensions/voice/tts-engine.ts    dispatch in synthesize(), warmupTts() → preloadParadee()
extensions/voice/tts-local-models.ts  catalog entry paradee-8m-v1_0, multi-file HF installer
extensions/voice/sherpa-loader.ts  prime onnxruntime-node before sherpa (the load-order fix)
extensions/voice.ts               warm-up, spoken-message ledger, chunk cancel, speak-on-demand
extensions/voice/config.ts        ttsAutoSpeakMaxChars, speakShortcut, autoSpeakShortcut
extensions/voice/audio-tool.ts    Windows dshow device pick
extensions/voice/model-download.ts  retry + resume
package.json                      onnxruntime-node, phonemizer as optional deps
```

## Why

Kokoro on this machine is slower than speech: **RTF 2.2**, i.e. generating a 298-character reply takes
33.8 seconds and then you listen to it for 18. Speaking is useless when it lags the conversation, and
`sherpa`'s `numThreads` barely moves it (2.36 → 2.21 across 2..12 threads — the transformer encoder
does not scale here).

Paradee is the same voice, distilled. On the same box:

| model                  | RTF, 1 thread | RTF, 4 threads | 298-char reply | audio | disk   |
| ---------------------- | ------------- | -------------- | -------------- | ----- | ------ |
| `kokoro-int8-en-v0_19` | 2.20          | 2.20           | 33.8 s         | 18.3 s | 152 MB |
| `kitten-nano-en-v0_2`  | 0.54          | —              | ~12 s          | 18.0 s | 41 MB  |
| **`paradee-8m-v1_0`**  | **0.12**      | **0.07**       | **1.4 s**      | 18.3 s | 8.7 MB |

Measured through the shipped code path (`synthesize()`, not a side script): cold **3.9 s** including
the one-time ONNX session load, then warm **RTF 0.086 — 8.65 s of audio in 743 ms**. Per-utterance
numbers for four sentence lengths are in [`bench/paradee.txt`](bench/paradee.txt); the Kokoro and
Kitten baselines are in [`bench/perf.txt`](bench/perf.txt) and [`bench/probe3.txt`](bench/probe3.txt).

Intelligibility was not taken on faith: the local Parakeet-v3 ASR transcribes Paradee's own output at
**5.6 % WER over 54 words** (the misses are "DirectShow" → "direct show" and comma placement), against
upstream's own Whisper-measured 3 % and Kokoro's 5.7 %. Transcript and reference in
[`bench/wer.txt`](bench/wer.txt); the four wavs in `bench/` are the audio that was scored.

## How it works

sherpa-onnx's `kokoro` slot cannot host this model. That slot takes **text**, phonemizes internally
with `espeak-ng-data`, and mixes a `voices.bin` speaker embedding. Paradee's graph is

```
input_ids  int64   [1, T]   misaki phoneme ids, 0 pad at both ends, T ≤ 512
speed      float32 [1]      1.0 = model rate
→ waveform float32 [1, N]   mono, 24 kHz, one voice baked in
```

so `tts-paradee.ts` drives `onnxruntime-node` directly and exposes the same
`synthesize(text, opts)` contract the engine already calls.

**G2P is two stages and both are load-bearing.** `phonemizer` (eSpeak NG compiled to wasm) produces
IPA, then the vendored eSpeak→misaki table (`web/misaki.js` upstream, Apache-2.0) rewrites it into
the id space the model was trained on. Fed raw eSpeak phonemes the model mumbles — upstream measured
WER 31 % → 3 % from that conversion alone. Sentence punctuation is also pulled out and re-inserted,
because eSpeak-based phonemizers drop it and Paradee's vocabulary has prosody ids for it.

Text is chunked to the 510-phoneme window at sentence boundaries, sessions are cached per model id
(one ONNX session, reused), `abort` is wired to the existing playback abort, and a NaN guard rejects
a degenerate waveform instead of playing silence.

## The load-order landmine

`sherpa-onnx-node` and `onnxruntime-node` each bundle their own ONNX Runtime, and **the one that
dlopens second is refused by the Windows loader**:

```
Error: Speak failed: Paradee needs the `onnxruntime-node` and `phonemizer` packages,
which are not installed (The operating system cannot run %1.
\??\C:\Users\…\onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime_binding.node)
```

The packages *were* installed; load order was the only variable. `sherpa → onnxruntime-node` is fatal
for the whole session; `onnxruntime-node → sherpa` is fine for both. A lazily loaded Paradee backend
loses that race in any session where the **microphone was used before the first spoken reply**, and
`voice.ts` loads its 26 `./voice/*` modules with `await import()`, so no entry-level import can win.

The fix therefore sits at the choke point: `loadSherpa()` — the only way sherpa enters the process —
imports `onnxruntime-node` first (~30 ms, once, a no-op when the optional dep is absent).
`tts-paradee.ts` keeps a module-level prime as the fallback for sessions that speak before listening.
`paradee/patches/pi-voicekit-paradee-tts/test_load_order.mjs` proves both orders in one process, with
real inference on both backends.

**Any future second ONNX backend must be primed before `loadSherpa()`, or the OS will refuse its
binding.**

## The other seven fixes

Paradee made three of these visible and one of them worse, which is the honest reason they are in the
same repo:

| commit | why it exists |
| ------ | ------------- |
| Unpack model archives without `tar` | Windows has no `tar` on the PATH pi spawns; the installer deadlocked at "Extracting…" forever |
| Pick a working DirectShow microphone | capture with no explicit device grabbed a silent endpoint → "Microphone captured no audio" |
| Retry model downloads | one reset during a 600 MB download failed the whole install with no resume |
| Stop the whole spoken reply | Esc killed the playing utterance only; every queued chunk still started, so it "kept restarting on the next paragraph" |
| Narrate each reply once | **caused by the speedup**: the turn_end fallback inferred "nobody spoke" from playback state, which Paradee (RTF 0.08) had already cleared → the reply was spoken twice |
| Warm the TTS model at session start | `warmupTts()` was exported and never called: first utterance 4111 ms → 827 ms |
| Speak on demand | it narrated every reply with no length limit and no way to ask for one; adds `alt+s`, `alt+a`, `/voice-read`, `/voice-autospeak`, `voice.ttsAutoSpeakMaxChars` |

## Using it

Set in `~/.pi/agent/settings.json` (or via `/voice-settings`):

```jsonc
"voice": {
  "ttsEnabled": true,
  "ttsBackend": "local",
  "ttsLocalModel": "paradee-8m-v1_0",
  "ttsLocalVoiceId": 0,
  "ttsSpeed": 1.25,
  "ttsAutoSpeak": true,
  "ttsAutoSpeakMaxChars": 400,   // 0 = upstream behaviour (speak everything)
  "speakShortcut": "alt+s",      // read the last reply / stop
  "autoSpeakShortcut": "alt+a"   // mute auto-narration without touching ttsEnabled
}
```

| key / command | does |
| ------------- | ---- |
| `alt+s` | stop if speaking, else read the last assistant reply aloud |
| `alt+a` | mute/unmute auto-narration only (`/voice-speak` keeps working) |
| `/voice-read [text]` | same as `alt+s`, or read the given text |
| `/voice-autospeak [on\|off\|status\|<maxChars>]` | the cap and the mute from the keyboard |
| `/voice-speak-stop` | stop the reply and everything queued behind it |

The model is installed by pi-voicekit itself (Settings → TTS → Paradee, or the model picker): one
`paradee_int8.onnx` + `config.json` from Hugging Face, SHA-256 pinned in the catalog
(`60e8f8a1…98eb`), landing in `~/.pi/models/tts/paradee-8m-v1_0/`. Nothing is downloaded at speak time.

## Building / verifying

```bash
# rebuild this tree from upstream v0.4.2 + the patch set (proof it is what the patches produce)
git clone --branch v0.4.2 https://github.com/CyFeng16/pi-voicekit.git /tmp/vk
bash paradee/scripts/replay-patches.sh /tmp/vk
diff -r /tmp/vk/extensions extensions    # empty
```

The eight commits in this repo were produced exactly that way, one patch per commit. The same patch
directories under [`paradee/patches/`](patches/) are what keep a **node_modules** install patched:

```bash
bash paradee/patches/apply_all.sh     # → "all patches applied and self-tested"
```

Each `apply.sh` is idempotent (it greps for the symbol it introduces, or for the upstream fix) and
self-tests with its own `test_*.mjs`. `paradee/patches/README.md` explains the update ritual and
carries one paste-ready `upstream-issue.md` per patch — **none of them have been posted** to
CyFeng16/pi-voicekit yet; posting them is what makes the patch directory unnecessary.

## Why a fork

pi-voicekit lives in `~/.pi/agent/npm/node_modules`, so every `pi update` wipes local edits. Two ways
out: patch after each update, or own the tree. This repo is the second, and keeps the first as
`paradee/patches/` so either path works.

To run the fork instead of the npm package:

```bash
pi install /path/to/this/repo     # path installs are skipped by pi's updater
```

If you keep the npm package, pin it — `"npm:pi-voicekit@0.4.2"` (exact version) makes pi's package
manager skip the update check entirely (`if (parsed.type === "local" || parsed.pinned) return undefined`).

## Known gaps

- **CI lockfile.** `package.json` gained `onnxruntime-node` and `phonemizer` as optional deps and
  `bun.lock` was not regenerated (no bun on the machine this was built on), so
  `bun install --frozen-lockfile` in `.github/workflows/ci.yml` will complain. `npm install` and
  `pi install` are unaffected; run `bun install` once after cloning to fix it.
- **Upstream tests.** The fork does not add tests to `tests/`; the per-patch self-tests live next to
  each patch in `paradee/patches/*/test_*.mjs`. `bun run check` is unverified on this tree.
- **Not published to npm.** `package.json` still says `pi-voicekit@0.4.2` on purpose, so the tree
  stays byte-identical to what is deployed. Publishing would need a name and a version bump.
- **One voice.** Paradee bakes `af_heart` in; `ttsLocalVoiceId` is accepted and ignored.

## Licence

MIT, as upstream (see [`LICENSE`](LICENSE)). The vendored eSpeak→misaki table inside
`extensions/voice/tts-paradee.ts` is Apache-2.0 from Paradee upstream. The model file is
Apache-2.0 and is not in this repo.
