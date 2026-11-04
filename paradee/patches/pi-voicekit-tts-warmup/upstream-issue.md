# `warmupTts()` is exported but never called — the first spoken reply pays a hidden ~2–4 s model load

pi-voicekit 0.4.2, `extensions/voice/tts-engine.ts:274`:

```ts
export async function warmupTts(
	model: TtsLocalModelInfo,
	modelDir: string,
	opts: { signal?: AbortSignal } = {}
): Promise<boolean> { … }
```

```
$ grep -rn "warmupTts" extensions/
extensions/voice/tts-engine.ts:274:export async function warmupTts(
```

That is the only occurrence in the package — nothing calls it. So the first
`speak()` of every process includes ONNX session creation, graph optimisation and
the first G2P load, inside the reply the user is waiting for. Measured on a
Ryzen desktop, same text, same machine:

| model | first utterance | every later utterance |
|---|---|---|
| `paradee-8m-v1_0` | 4 107 ms for 8.65 s of audio (RTF 0.475) | 696–782 ms (RTF 0.080) |
| `kokoro-int8-en-v0_19` | ~1.9 s | RTF ≈ 2.2 |
| `kitten-nano-en-v0_2` | similar | RTF ≈ 0.48 |

It is a one-line-shaped gap, because the pattern is already in the codebase: at
`session_start`, `voice.ts` calls `preparePunctuation()` with the comment that
"no dictation ever waits for a background build". Speech output has no equivalent.

## What I did locally (4 hunks in `extensions/voice.ts`)

```ts
const ttsWarmupAttempted = new Set<string>();
export async function warmupSelectedTts(getConfig: () => VoiceConfig, reason: string): Promise<boolean> {
	const cfg = getConfig();
	if (!cfg || cfg.ttsEnabled !== true) return false;
	if ((cfg.ttsBackend ?? "local") !== "local") return false;   // cloud: nothing to warm
	const modelId = cfg.ttsLocalModel || "kitten-nano-en-v0_2";
	if (ttsWarmupAttempted.has(modelId)) return false;
	ttsWarmupAttempted.add(modelId);
	try {
		const { getTtsModel, isTtsModelInstalled, getInstalledTtsModelDir } =
			await import("./voice/tts-local-models");
		if (!isTtsModelInstalled(modelId)) { ttsWarmupAttempted.delete(modelId); return false; }
		const { warmupTts } = await import("./voice/tts-engine");
		const ok = await warmupTts(getTtsModel(modelId), getInstalledTtsModelDir(modelId));
		if (!ok) ttsWarmupAttempted.delete(modelId);
		return ok;
	} catch { ttsWarmupAttempted.delete(modelId); return false; }
}
```

called with `void` from three places: `session_start` (right after
`preparePunctuation()`), `/voice-speak-toggle` when enabling, and
`finalizeAndSaveSetup()` so a model picked in the panel is resident before the
next reply. `getConfig` is a thunk because `config` is reassigned on every
`session_start` and save; the `Set` is keyed on model id so switching models
warms the new one and never re-warms the old; failures are dropped from the set so
a later turn can retry.

Result:

```
warmupSelectedTts() at session_start: 3722 ms  (background)
first synthesize() afterwards:        827 ms    (was 4 111 ms)
```

Two design questions worth your call before a PR:

1. **Residency cost.** With TTS on, the engine is now loaded for the whole
   session rather than lazily — a few hundred MB for Kokoro-int8. That matches
   what the punctuation engine already does, but it is a deliberate trade rather
   than a free win.
2. **`pi --print`.** A one-shot run that never speaks now pays the load too.
   Gating the kick on `ctx.hasUI` avoids that, at the cost of losing the warmup
   for headless runs that *do* speak.

Happy to send a PR with the helper, the three call sites and the self-test
(gating + wiring + a real post-warmup `synthesize()` timed under the cold path).
