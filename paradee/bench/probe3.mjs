// Same measurement through the extension path for the OTHER installed local TTS model,
// to compare perceived latency against kokoro-int8 (RTF ~2.2 measured in probe_tts_perf.mjs).
// Run: node ~/ttsdbg/probe3.mjs
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PI = path.join(os.homedir(), ".pi", "agent", "install", "releases", "1.3.0", "node_modules");
const { createJiti } = require(path.join(PI, "jiti"));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const NPM = path.join(os.homedir(), ".pi", "agent", "npm");
const engine = await jiti.import(path.join(NPM, "node_modules/pi-voicekit/extensions/voice/tts-engine.ts"));
const models = await jiti.import(path.join(NPM, "node_modules/pi-voicekit/extensions/voice/tts-local-models.ts"));
const t = () => Number(process.hrtime.bigint() / 1_000_000n);

const TEXTS = [
	"Yes.",
	"Your microphone is fixed now, and it was never a permissions problem at all.",
	"Your microphone is fixed now, and it was never a permissions problem at all. The extension asked DirectShow for a device that does not exist on Windows. Restart pi and try push to talk again with the usual shortcut.",
];

for (const id of ["kitten-nano-en-v0_2", "kokoro-int8-en-v0_19"]) {
	let model, modelDir;
	try {
		model = models.getTtsModel(id);
		modelDir = models.getInstalledTtsModelDir(id);
	} catch (e) {
		console.log(`${id}: not installed (${e.message})`);
		continue;
	}
	console.log(`\n${id} slot=${model.sherpaSlot} sr=${model.sampleRate} voices=${model.voices.length}`);
	await engine.synthesize({ text: "warmup", model, modelDir, language: "en", sid: model.defaultSid, speed: 1.25 });
	for (const text of TEXTS) {
		const t0 = t();
		const a = await engine.synthesize({ text, model, modelDir, language: "en", sid: model.defaultSid, speed: 1.25 });
		const ms = t() - t0;
		const dur = a.samples.length / a.sampleRate;
		console.log(`  ${String(text.length).padStart(4)} ch → ${String(ms).padStart(6)} ms, audio ${dur.toFixed(2)} s, RTF ${(ms / 1000 / dur).toFixed(2)}`);
	}
}
