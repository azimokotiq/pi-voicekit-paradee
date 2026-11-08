# Paradee voice for pi

**This fork of [pi-voicekit](https://github.com/CyFeng16/pi-voicekit) makes the Pi coding agent speak
its replies with [Paradee-8M](https://github.com/sahilmahendrakar/paradee)** — Kokoro's `af_heart`
voice distilled to 8.07M parameters in one 9 MB int8 ONNX file, and since **v1.2** four voices in that
one file (two American, two British) — and fixes the seven things that stood between that model and a
usable voice.

Fork base: pi-voicekit **v0.4.2** (MIT), pinned deliberately; see [Why a fork](#why-a-fork).
Upstream is untouched and this tree differs from `v0.4.2` by exactly eight commits.

```
extensions/voice/tts-paradee.ts   the backend: phonemize → misaki ids → onnxruntime → 24 kHz PCM
extensions/voice/paradee-g2p-worker.mjs  a per-accent eSpeak child process (British needs its own)
extensions/voice/tts-engine.ts    dispatch in synthesize(), warmupTts() → preloadParadee()
extensions/voice/tts-local-models.ts  catalog entry paradee-8m-v1_2, multi-file HF installer
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

| model                  | RTF, 1 thread | RTF, 4 threads | 298-char reply | disk   |
| ---------------------- | ------------- | -------------- | -------------- | ------ |
| `kokoro-int8-en-v0_19` | 2.20          | 2.20           | 33.8 s         | 152 MB |
| `kitten-nano-en-v0_2`  | 0.54          | —              | ~12 s          | 41 MB  |
| **`paradee-8m-v1_2`**  | **0.042**     | **0.021**      | **0.79 s**     | 8.5 MB |

RTF is synthesised-seconds per audio-second (lower is better); the reply column is the measured wall
clock for the same 298-character text, which is why it moves 43× while RTF moves 52× — the models do
not pace that text identically. The Paradee row was re-measured on v1.2 (2026-11-08); v1.0 measured
0.119 / 0.075 / 2.17 s on the same box, so v1.2 is also about 2.8× faster per audio-second.

Measured through the shipped code path (`synthesize()`, not a side script): cold **1.4 s** including
the one-time ONNX session load, then warm **RTF 0.039 — 9.13 s of audio in 355 ms**. Per-utterance
numbers for four sentence lengths, in both `af_heart` and `bf_isabella`, are in
[`bench/paradee.txt`](bench/paradee.txt) and [`bench/paradee_bf_isabella.txt`](bench/paradee_bf_isabella.txt);
the Kokoro and Kitten baselines are in [`bench/perf.txt`](bench/perf.txt) and
[`bench/probe3.txt`](bench/probe3.txt).

Intelligibility was not taken on faith: the local Parakeet-v3 ASR transcribes Paradee's own output at
**7.4 % WER over 54 words** in `af_heart` and **9.3 %** in the British `bf_isabella` (the misses are
"DirectShow" → "direct show", "asked" → "ask", comma placement), against upstream's own Whisper-measured
3 % and Kokoro's 5.7 %. Parakeet-v3 is an American model scoring a British accent, so the second number
over-states. Transcript and reference in [`bench/wer.txt`](bench/wer.txt); the eight wavs in `bench/`
are the audio that was scored.

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

```
input_ids  int64   [1, T]   misaki phoneme ids, 0 pad at both ends, T ≤ 512
speed      float32 [1]      1.0 = model rate
voice      int64   [1]      speaker index — v1.2 only
→ waveform float32 [1, N]   mono, 24 kHz
```

v1.0 and v1.1 take no `voice` input (af_heart is baked into the weights and there is no speaker to
select), so the backend feeds `voice` only when the loaded graph declares that input.

**The four voices, in the model's own order** (`config.json: voices`), with the pitch the shipped
`test_paradee.mjs` measures on this box:

| sid | voice         | accent   | gender | UTMOS (upstream) | measured f0 |
| --- | ------------- | -------- | ------ | ---------------- | ----------- |
| 0   | `af_heart`    | American | female | 4.40             | ~216 Hz     |
| 1   | `bf_isabella` | British  | female | 4.06             | ~202 Hz     |
| 2   | `am_puck`     | American | male   | 4.32             | ~124 Hz     |
| 3   | `bm_fable`    | British  | male   | 4.18             | ~162 Hz     |

**G2P is two stages and both are load-bearing.** `phonemizer` (eSpeak NG compiled to wasm) produces
IPA, then the vendored eSpeak→misaki table (`web/misaki.js` upstream, Apache-2.0) rewrites it into
the id space the model was trained on. Fed raw eSpeak phonemes the model mumbles — upstream measured
WER 31 % → 3 % from that conversion alone. Sentence punctuation is also pulled out and re-inserted,
because eSpeak-based phonemizers drop it and Paradee's vocabulary has prosody ids for it.

**One table, two products.** Hearline — the Chrome extension that ships this model — builds its
golden phoneme fixtures from `bench/misaki.js`: real eSpeak output in both accents, mapped through
this table, pinned to `test/fixtures/gb-misaki.json` and asserted in its unit suite. Hearline 1.4.0
shipped a hand-written British branch instead, and its two British voices came out as mush: `oʊ`,
`eə` and `ɜː` are what eSpeak writes, they are not the ids the model was trained on, and a phoneme
the vocabulary has no id for is dropped in silence. Change this table and their build says so.

**The two accents need two phonemizer processes.** The British voices were trained on misaki's
*British* dictionary, so `bf_`/`bm_` must be phonemized in `en-gb` and passed through the table's
British branch (`əʊ`→`Q`, `eə`→`ɛː` before the `e`→`A` rule, `ðɪ`→`ði` before a vowel, length marks
kept). `phonemizer` applies its `language` argument to the **first call of the process only** — the
eSpeak voice is process-global — so a British voice in a session that spoke first would silently get
American phonemes. Verified on phonemizer@1.2.1 under node 24 and bun 1.4. The backend therefore
keeps the accent the in-process wasm latched onto in-process (free) and routes every other accent
through one `paradee-g2p-worker.mjs` child process per accent: unref'd handles, so an idle worker
never holds pi's event loop open, killed on `releaseParadee()`. Cost is the ~0.4 s wasm load, once per
accent per session, then a few ms per utterance. Two deviations from upstream's table are documented
in the code: dark-`ɫ` is folded to `l` (the vocabulary has no ɫ, so upstream's runtime loses the l of
"milk" and "world"), and `eə` is rewritten before `e`→`A` can eat it.

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
  "ttsLocalModel": "paradee-8m-v1_2",
  "ttsLocalVoiceId": 0,          // 0 af_heart · 1 bf_isabella · 2 am_puck · 3 bm_fable
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
`paradee_int8.onnx` (8,462,119 bytes) + `config.json` from Hugging Face
(`sahilmahendrakar/Paradee-8M-v1.2`, pinned to commit `ed2934d4…`), SHA-256 pinned in the catalog
(`a6989796692ac173…97da1`), landing in `~/.pi/models/tts/paradee-8m-v1_2/`. Nothing is downloaded at
speak time. The catalog id changed with the model (`paradee-8m-v1_0` → `paradee-8m-v1_2`) because the
graph, the vocabulary and the voice count all changed: an install that has the old directory should
have it deleted once the new one is in place, and `ttsLocalModel` re-saved from Settings points at
the new id.

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
- **Voices.** All four v1.2 voices are reachable: `ttsLocalVoiceId` 0…3 in settings, the voice row in
  `/voice-settings`, and a name (`"af_heart"`, `"bm_fable"`, …) for programmatic `synthesize()` calls.
  `ttsLocalVoiceId` stays a **number** in settings — config validation rejects strings there by design
  (upstream comment, `config.ts:304`).
- **British G2P is eSpeak, not misaki-en.** The British voices were trained on misaki's British
  dictionary; the closest open implementation reachable from a node process is eSpeak NG's `en-gb`
  plus upstream's eSpeak→misaki British branch, which is what runs. It is measured, not assumed
  (9.3 % WER on an American ASR, and `bench/paradee_bf_isabella.wav` to listen to). Misfit words to
  watch are the ones where eSpeak's `en-gb` and misaki's dictionary disagree — `rare`/`plain` and
  words with an `ɫ` the model has no id for.
- **The second accent costs one child process.** A session that speaks both American and British
  voices runs one `paradee-g2p-worker.mjs` per accent (~0.4 s each, cold). A single-accent session
  never spawns one.
- **v1.0/v1.1 are gone from the catalog.** The graph changed shape (a `voice` input), so the v1.2
  backend would refuse the old file; the old model directory can be deleted.

## Licence

MIT, as upstream (see [`LICENSE`](LICENSE)). The vendored eSpeak→misaki tables (American and British)
inside `extensions/voice/tts-paradee.ts` are Apache-2.0 from Paradee upstream. The model file is
Apache-2.0 and is not in this repo.
