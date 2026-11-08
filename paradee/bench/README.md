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
| `probe_paradee.mjs` | Paradee end to end **without pi**: eSpeak → misaki ids → onnxruntime → wav, RTF at 1 and 4 threads over four text lengths, writes `paradee_<n>ch[_<voice>].wav`. Captured in `paradee.txt` (af_heart) and `paradee_bf_isabella.txt` (v1.2's British voice) |
| `probe2.mjs`, `probe3.mjs` | the same comparison for Kitten Nano and Kokoro side by side. Captured in `probe2.txt`, `probe3.txt` |
| `probe_wer.mjs` | transcribes the wavs above with the local Parakeet-v3 ASR and scores WER against the source text. Captured in `wer.txt` |
| `paradee_tts.py` | the first spike: Paradee from Python (the model is distributed as a Python package), used to confirm the graph contract before writing any TypeScript |
| `instrument_paradee.cjs` | patches the loaded `tts-paradee.ts` at runtime to print phoneme ids and session timings — how the 510-phoneme window and the misaki ids were verified against the Python reference |
| `measure_reply.mjs` | times a real assistant reply through the shipped `synthesize()` path (cold load, then warm) |
| `test_pi_order.mjs`, `sim_mic_first.mjs` | the load-order experiment: real inference on sherpa **and** Paradee in one process, in both import orders. `sim_mic_first.mjs` reproduces the live failure (mic used before the first spoken reply) |
| `misaki.js` | the eSpeak→misaki table (American + British dictionaries, Paradee v1.2) — `probe_paradee.mjs` runs under plain node and cannot import the TypeScript backend, so it carries this copy; `tests/tts-paradee.test.ts` asserts it agrees with the shipped table over a corpus, so it cannot drift |
| `*.wav` | Paradee output for 4 / 76 / 152 / 298 characters, 24 kHz mono 16-bit, in `af_heart` (American) and `bf_isabella` (British) — the files `probe_wer.mjs` scored |

## Headline results

Paradee **v1.2**, measured 2026-11-08 on the machine above:

```
# paradee.txt — af_heart (American), no pi in the way
threads=1   298 ch →  787 ms, audio 18.93 s, RTF 0.042
threads=4   298 ch →  400 ms, audio 18.93 s, RTF 0.021

# paradee_bf_isabella.txt — bf_isabella (British), en-gb G2P
threads=1   298 ch →  725 ms, audio 17.63 s, RTF 0.041
threads=4   298 ch →  378 ms, audio 17.63 s, RTF 0.021

# perf.txt — Kokoro through sherpa, same text (measured on v1.0-era Paradee)
warm synthesize  15950 ms  audio 6.95 s  RTF 2.296
threads 2 → RTF 2.357 | 4 → 2.206 | 6 → 2.199 | 8 → 2.260 | 12 → 2.208   (does not scale)

# wer.txt — Parakeet-v3 (an American ASR) transcribing Paradee's own output
paradee_298ch.wav            WER  7.4 % over 54 words   (af_heart)
paradee_152ch.wav            WER 11.1 % over 27 words
paradee_298ch_bf_isabella.wav WER 9.3 % over 54 words   (British, scored by an American model)
paradee_152ch_bf_isabella.wav WER 11.1 % over 27 words
```

Through the shipped code path (`synthesize()`, model loaded once per session): cold **1.4 s**, warm
**RTF 0.039** — 9.13 s of audio in 355 ms (`test_paradee.mjs`, same box).

The v1.0 numbers these rows replace were RTF 0.119 (1 thread) / 0.075 (4 threads) and WER 5.6 % over
54 words; v1.2 is a distillation of the same recipe with two more voices and is roughly 2.8× faster
per audio-second on one thread here.

## Re-running

The probes resolve the installed package and the models in `~/.pi/models`, so they need a working
`~/.pi/agent/npm/node_modules/pi-voicekit` with the Paradee patch applied and
`~/.pi/models/tts/paradee-8m-v1_2/paradee_int8.onnx` present. They read and write next to
themselves — no scratch directory involved.

```bash
node paradee/bench/probe_paradee.mjs                        # af_heart, ~15 s, writes the wavs
PARADEE_VOICE=1 node paradee/bench/probe_paradee.mjs        # bf_isabella (British)
node paradee/bench/probe_wer.mjs                            # needs the Parakeet-v3 STT model
```

`PARADEE_VOICE` is a speaker index into the model's own `voices` list and `PARADEE_ACCENT` is inferred
from its prefix (`bf_`/`bm_` → `en-gb`). One process measures **one** accent: `phonemizer` latches its
language at its first call, so a probe that asked for en-gb after en-us in the same process would
measure American phonemes wearing a British name.

`probe_tts_perf.mjs` and `probe2/3.mjs` still want the Kokoro and Kitten models installed; without
them they fail at model load, which is expected and is why their output is checked in.
