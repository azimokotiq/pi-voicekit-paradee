// Reproduces the LIVE pi order in one process, which is what broke Paradee:
//   pi loads extensions/voice.ts (→ tts-engine → tts-paradee primes ONNX Runtime)
//   and only later the microphone/punctuation path dlopens sherpa-onnx-node,
// then asserts BOTH TTS backends work. ROLE=sherpa-first reproduces the losing
// order in a child process, where Paradee must fail with the load-order
// explanation rather than "packages are not installed".
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Module from "node:module";
import assert from "node:assert";
import { execFileSync } from "node:child_process";

const NPM = path.join(os.homedir(), ".pi", "agent", "npm");
const PKG = path.join(NPM, "node_modules", "pi-voicekit");
{
	const relRoot = path.join(os.homedir(), ".pi", "agent", "install", "releases");
	const extra = [];
	for (const v of fs.readdirSync(relRoot).sort().reverse()) extra.push(path.join(relRoot, v, "node_modules"));
	process.env.NODE_PATH = [...(process.env.NODE_PATH ? [process.env.NODE_PATH] : []), ...extra].join(path.delimiter);
	Module._initPaths();
}
const require = Module.createRequire(path.join(NPM, "noop.cjs"));
const jiti = require("jiti")(import.meta.filename);
const TEXT = "The quick brown fox jumps over the lazy dog, then stops to think.";

if (process.env.ROLE === "sherpa-first") {
	require("sherpa-onnx-node"); // sherpa wins the race, exactly as in a live session
	const cat = jiti(path.join(PKG, "extensions", "voice", "tts-local-models.ts"));
	const eng = jiti(path.join(PKG, "extensions", "voice", "tts-engine.ts"));
	try {
		await eng.synthesize({ text: TEXT, model: cat.getTtsModel("paradee-8m-v1_0"), modelDir: cat.getInstalledTtsModelDir("paradee-8m-v1_0"), language: "en" });
		console.log("UNEXPECTED: Paradee worked even with sherpa loaded first");
	} catch (err) {
		const m = String(err?.message ?? err);
		console.log(/already has a different copy resident/.test(m) ? "HAZARD MESSAGE OK (names the real cause)" : "HAZARD MESSAGE WRONG");
		console.log("  " + m.replace(/\s+/g, " ").slice(0, 220));
	}
	process.exit(0);
}

const voice = jiti(path.join(PKG, "extensions", "voice.ts")); // the extension entry point, as pi loads it
assert.equal(typeof voice.default, "function", "voice.ts must export the extension");

const cat = jiti(path.join(PKG, "extensions", "voice", "tts-local-models.ts"));
const eng = jiti(path.join(PKG, "extensions", "voice", "tts-engine.ts"));
const par = jiti(path.join(PKG, "extensions", "voice", "tts-paradee.ts"));
assert.equal(par.isParadeeRuntimeReady(), true, "ORT must already be resident after the extension loads");
console.log("1. extension loaded → onnxruntime-node resident");

const sherpa = require("sherpa-onnx-node"); // STT/punctuation path, arriving late as in a live session
assert.ok(sherpa.OfflineTts || sherpa.OfflineRecognizer, "sherpa failed to load");
console.log("2. sherpa-onnx-node dlopens AFTER ORT → ok");

const kitten = await eng.synthesize({
	text: TEXT,
	model: cat.getTtsModel("kitten-nano-en-v0_2"),
	modelDir: cat.getInstalledTtsModelDir("kitten-nano-en-v0_2"),
	language: "en",
});
assert.ok(kitten.samples.length > 20000, "kitten produced no audio");
console.log(`3. sherpa backend ran real inference: ${kitten.samples.length} samples @ ${kitten.sampleRate} Hz`);

const paradee = await eng.synthesize({
	text: TEXT,
	model: cat.getTtsModel("paradee-8m-v1_0"),
	modelDir: cat.getInstalledTtsModelDir("paradee-8m-v1_0"),
	language: "en",
});
assert.ok(paradee.samples.length > 50000, "paradee produced no audio");
console.log(`4. paradee backend ran real inference: ${paradee.samples.length} samples @ ${paradee.sampleRate} Hz`);
console.log("PI LOAD ORDER — BOTH ONNX RUNTIMES COEXIST: PASS");
