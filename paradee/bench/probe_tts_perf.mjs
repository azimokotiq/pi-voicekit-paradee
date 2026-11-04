// TTS latency probe for pi-voicekit local backend (kokoro-int8-en-v0_19 on this box).
// Measures: model load, first-call latency, per-call overhead, and RTF vs numThreads.
// Run: node ~/ttsdbg/probe_tts_perf.mjs
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
const sherpaMod = await jiti.import(path.join(NPM, "node_modules/pi-voicekit/extensions/voice/sherpa-loader.ts"));

const ID = "kokoro-int8-en-v0_19";
const model = models.getTtsModel(ID);
const modelDir = models.getInstalledTtsModelDir(ID);
console.log(`model ${ID} slot=${model.sherpaSlot} sampleRate=${model.sampleRate} voices=${model.voices.length} dir=${modelDir}`);

const SENTENCE =
	"Your microphone is fixed — the extension was asking DirectShow for a device literally named Microphone, which never matches anything on Windows.";
const SHORT = "Microphone is fixed.";

const t = () => Number(process.hrtime.bigint() / 1_000_000n);

// ── 1. the extension's own path: cold call (includes model load) then warm calls ──
const opts = { model, modelDir, language: "en", sid: 3, speed: 1.25 };
let t0 = t();
let a = await engine.synthesize({ ...opts, text: SENTENCE });
const cold = t() - t0;
console.log(`cold synthesize   ${String(cold).padStart(6)} ms  audio ${(a.samples.length / a.sampleRate).toFixed(2)} s  sr=${a.sampleRate}`);

t0 = t();
a = await engine.synthesize({ ...opts, text: SENTENCE });
console.log(`warm synthesize   ${String(t() - t0).padStart(6)} ms  audio ${(a.samples.length / a.sampleRate).toFixed(2)} s  RTF ${((t() - t0) / 1000 / (a.samples.length / a.sampleRate)).toFixed(3)}`);

t0 = t();
a = await engine.synthesize({ ...opts, text: SHORT });
console.log(`short (${SHORT.length} ch)  ${String(t() - t0).padStart(6)} ms  audio ${(a.samples.length / a.sampleRate).toFixed(2)} s  ← per-call overhead`);

t0 = t();
a = await engine.synthesize({ ...opts, text: SENTENCE.repeat(3) });
console.log(`long  (${SENTENCE.length * 3} ch)  ${String(t() - t0).padStart(6)} ms  audio ${(a.samples.length / a.sampleRate).toFixed(2)} s`);

// ── 2. thread sweep with hand-built sherpa configs (extension hardcodes 6 for kokoro) ──
await sherpaMod.loadSherpa();
const sherpa = sherpaMod.getSherpaModule();
if (!sherpa) { console.error("sherpa-onnx-node unavailable:", sherpaMod.getSherpaError()); process.exit(1); }
const lexicon = [path.join(modelDir, "lexicon-us-en.txt"), path.join(modelDir, "lexicon-us-en.txt")]
	.map((p) => require("node:fs").existsSync(p))
	.reduce((acc, ok, i) => (ok ? [...acc, [path.join(modelDir, "lexicon-us-en.txt"), path.join(modelDir, "lexicon-gb-en.txt")][i]] : acc), []);

console.log("\nthreads  load ms   synthesize ms   audio s   RTF");
for (const threads of [2, 4, 6, 8, 12]) {
	const cfg = {
		model: {
			kokoro: {
				model: path.join(modelDir, "model.int8.onnx"),
				voices: path.join(modelDir, "voices.bin"),
				tokens: path.join(modelDir, "tokens.txt"),
				dataDir: path.join(modelDir, "espeak-ng-data"),
				lengthScale: 1.0,
				...(lexicon.length ? { lexicon } : {}),
			},
		},
		numThreads: threads,
		provider: "cpu",
	};
	let lt = t();
	const tts = await sherpa.OfflineTts.createAsync(cfg);
	const loadMs = t() - lt;
	const tt = t();
	const audio = await tts.generateAsync({ text: SENTENCE, sid: 3, speed: 1.25 });
	const ms = t() - tt;
	const dur = audio.samples.length / (audio.sampleRate || 24000);
	console.log(
		String(threads).padEnd(7),
		String(loadMs).padStart(7),
		"  ",
		String(ms).padStart(12),
		"  ",
		dur.toFixed(2).padStart(7),
		" ",
		(ms / 1000 / dur).toFixed(3),
	);
	if (typeof tts.free === "function") tts.free();
	else if (typeof tts.destroy === "function") tts.destroy();
}
