// G2P worker for the Paradee TTS backend (see tts-paradee.ts).
//
// WHY THIS FILE EXISTS
// `phonemizer` (eSpeak NG compiled to wasm) applies its `language` argument
// only to the FIRST call in a process: every later call keeps speaking with
// the first accent, whatever you ask for. Verified 2026-11-08 on
// phonemizer@1.2.1, node 24 and bun 1.4, in one process:
//
//   phonemize(t1, "en-us") → "bˈæθ ˌoʊvɚ"     (American, correct)
//   phonemize(t2, "en-gb") → "bˈeɪð ˌoʊvɚ"    (still American — the bug)
//
// Paradee v1.2 needs BOTH accents in one session: `af_`/`am_` voices were
// trained on misaki's American dictionary, `bf_`/`bm_` on its British one, and
// feeding a British voice American phonemes mumbles it (upstream measures
// Whisper WER 31% for the wrong G2P against 3% for the right one). eSpeak's
// wasm voice is process-global, so the only reliable way to get a second
// accent is a second process. That is this worker: one child per accent,
// spawned lazily, kept alive, killed when the voice is released.
//
// PROTOCOL (readline, one JSON object per line)
//   in:  {"id": 3, "text": "…"}
//   out: {"id": 3, "phonemes": ["…"]} | {"id": 3, "error": "…"}
// The accent comes from argv and never changes for the life of the child:
//   node paradee-g2p-worker.mjs en-gb
import { createInterface } from "node:readline";
import { phonemize } from "phonemizer";

const lang = process.argv[2] || "en-us";

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	try {
		const phonemes = await phonemize(msg.text, lang);
		process.stdout.write(`${JSON.stringify({ id: msg.id, phonemes })}\n`);
	} catch (e) {
		process.stdout.write(`${JSON.stringify({ id: msg.id, error: String((e && e.message) || e) })}\n`);
	}
});
