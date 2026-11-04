// Where does local TTS time go? Splits fixed per-call cost from per-character cost,
// measures time-to-first-audio if playback were streamed (sherpa onProgress), and
// compares one multi-sentence call against N single-sentence calls.
// Run: node ~/ttsdbg/probe2.mjs   (from ~/ttsdbg)
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

const ID = "kokoro-int8-en-v0_19";
const model = models.getTtsModel(ID);
const modelDir = models.getInstalledTtsModelDir(ID);
const t = () => Number(process.hrtime.bigint() / 1_000_000n);
const syn = async (text, extra = {}) => {
	const t0 = t();
	const a = await engine.synthesize({ text, model, modelDir, language: "en", sid: 3, speed: 1.25, ...extra });
	return { ms: t() - t0, dur: a.samples.length / a.sampleRate };
};

// warm the model once so load time is out of the numbers below
await syn("Warming up.");

const S1 = "Your microphone is fixed now, and it was never a permissions problem at all."; // 74
const S2 = "The extension asked DirectShow for a device that does not exist on Windows."; // 74
const S3 = "Restart pi and try push to talk again with the usual shortcut."; // 60
const S4 = "Input gain is low, so raising the Windows mic level gives the model more headroom."; // 84

console.log("length sweep (one call each):");
for (const text of ["Yes.", S1, S1 + " " + S2, S1 + " " + S2 + " " + S3, S1 + " " + S2 + " " + S3 + " " + S4]) {
	const r = await syn(text);
	console.log(`  ${String(text.length).padStart(4)} ch → ${String(r.ms).padStart(6)} ms, audio ${r.dur.toFixed(2)} s, RTF ${(r.ms / 1000 / r.dur).toFixed(2)}`);
}

console.log("\none multi-sentence call vs four separate calls:");
const joined = [S1, S2, S3, S4].join(" ");
const j = await syn(joined);
console.log(`  joined  ${String(joined.length).padStart(4)} ch → ${String(j.ms).padStart(6)} ms, audio ${j.dur.toFixed(2)} s`);
let sum = 0, t0 = t();
for (const s of [S1, S2, S3, S4]) sum += (await syn(s)).ms;
console.log(`  4 calls          → ${String(sum).padStart(6)} ms synth total, wall ${t() - t0} ms`);

console.log("\ntime to FIRST sentence if playback streamed via onProgress:");
const streamed = [];
const st = t();
const a = await engine.synthesize({
	text: joined, model, modelDir, language: "en", sid: 3, speed: 1.25,
	onProgress: (chunk) => streamed.push({ at: t() - st, samples: chunk.samples.length, progress: chunk.progress }),
});
console.log(`  whole call ${t() - st} ms, audio ${a.samples.length / a.sampleRate} s, progress callbacks: ${streamed.length}`);
for (const s of streamed) console.log(`    +${String(s.at).padStart(6)} ms  ${String(s.samples).padStart(7)} samples  p=${s.progress}`);

console.log("\nspeed effect (same text):");
for (const speed of [1.0, 1.25, 1.6]) {
	const r = await syn(joined, { speed });
	console.log(`  speed ${speed} → ${String(r.ms).padStart(6)} ms, audio ${r.dur.toFixed(2)} s`);
}
