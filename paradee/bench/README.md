# Benchmarks and probes

The scripts that produced the numbers in [`../README.md`](../README.md), plus their raw output and the
audio that was scored. They are kept because the claim they support — *Paradee is 25× faster than
Kokoro at equal intelligibility* — is the reason this fork exists, and a claim without its harness is
just a sentence.

Machine: Windows 11 x64, i7-6850K (6C/12T), 32 GB, **CPU only** — both GPUs are occupied by the
coding model, which is the constraint the whole project is under. Everything below is
`CPUExecutionProvider`; no CUDA was involved.

## What each file does

| file | what it measures |
| ---- | ---------------- |
| `probe_tts_perf.mjs` | Kokoro through sherpa-onnx: cold/warm synthesize, short vs long text, and an RTF-vs-threads sweep (2…12). Captured in `perf.txt` |
| `probe_paradee.mjs` | Paradee end to end **without pi**: eSpeak → misaki ids → onnxruntime → wav, RTF at 1 and 4 threads over four text lengths, writes `paradee_<n>ch.wav`. Captured in `paradee.txt` |
| `probe2.mjs`, `probe3.mjs` | the same comparison for Kitten Nano and Kokoro side by side. Captured in `probe2.txt`, `probe3.txt` |
| `probe_wer.mjs` | transcribes the wavs above with the local Parakeet-v3 ASR and scores WER against the source text. Captured in `wer.txt` |
| `paradee_tts.py` | the first spike: Paradee from Python (the model is distributed as a Python package), used to confirm the graph contract before writing any TypeScript |
| `instrument_paradee.cjs` | patches the loaded `tts-paradee.ts` at runtime to print phoneme ids and session timings — how the 510-phoneme window and the misaki ids were verified against the Python reference |
| `measure_reply.mjs` | times a real assistant reply through the shipped `synthesize()` path (cold load, then warm) |
| `test_pi_order.mjs`, `sim_mic_first.mjs` | the load-order experiment: real inference on sherpa **and** Paradee in one process, in both import orders. `sim_mic_first.mjs` reproduces the live failure (mic used before the first spoken reply) |
| `misaki.js` | the eSpeak→misaki table, vendored here from Paradee upstream — `probe_paradee.mjs` needs it |
| `*.wav` | Paradee output for 4 / 76 / 152 / 298 characters, 24 kHz mono 16-bit — the files `probe_wer.mjs` scored |

## Headline results

```
# paradee.txt — Paradee, no pi in the way
threads=1   298 ch → 2173 ms, audio 18.25 s, RTF 0.119
threads=4   298 ch → 1362 ms, audio 18.25 s, RTF 0.075

# perf.txt — Kokoro through sherpa, same text
warm synthesize  15950 ms  audio 6.95 s  RTF 2.296
threads 2 → RTF 2.357 | 4 → 2.206 | 6 → 2.199 | 8 → 2.260 | 12 → 2.208   (does not scale)

# wer.txt — Parakeet-v3 transcribing Paradee's own output
paradee_298ch.wav  WER 5.6 % over 54 words
```

Through the shipped code path (`synthesize()`, model loaded once per session): cold **3.9 s**, warm
**RTF 0.086** — 8.65 s of audio in 743 ms.

## Re-running

The probes resolve the installed package and the models in `~/.pi/models`, so they need a working
`~/.pi/agent/npm/node_modules/pi-voicekit` with the Paradee patch applied and
`~/.pi/models/tts/paradee-8m-v1_0/paradee_int8.onnx` present. They are checked in **as they ran**,
which means two paths still point at the scratch directory they were written in
(`~/ttsdbg/misaki.js`, `~/ttsdbg/paradee_*.wav`) — copy this directory to `~/ttsdbg/` to re-run them
unchanged, or edit those two lines:

```bash
node paradee/bench/probe_paradee.mjs        # ~30 s, writes the wavs
node paradee/bench/probe_wer.mjs            # needs the Parakeet-v3 STT model
```

`probe_tts_perf.mjs` and `probe2/3.mjs` still want the Kokoro and Kitten models installed; without
them they fail at model load, which is expected and is why their output is checked in.
