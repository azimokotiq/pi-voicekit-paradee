// Load-order regression test for the Paradee backend.
//
// Reproduce pi's REAL order, not a convenient one:
//   pi imports extensions/voice.ts, which loads every ./voice/* module with
//   await import(). The first thing to touch a native ONNX Runtime is therefore
//   loadSherpa() (STT/punctuation), and sherpa-onnx-node + onnxruntime-node each
//   bundle their own copy of ONNX Runtime — the Windows loader refuses the
//   binding of whichever arrives second ("The operating system cannot run %1").
// The patch primes onnxruntime-node inside loadSherpa() so that whichever
// feature runs first, ORT is always the first copy resident.
//
//   ROLE=safe-order   : loadSherpa() first (as pi does), then BOTH backends run
//                       real inference in the same process — this is what broke.
//   ROLE=raw-sherpa   : bypass the prime with a raw require("sherpa-onnx-node");
//                       Paradee must then fail with the explanatory message
//                       rather than "packages are not installed".
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Module from "node:module";
import assert from "node:assert";
import { spawnSync } from "node:child_process";

const NPM = path.join(os.homedir(), ".pi", "agent", "npm");
const PKG = path.join(NPM, "node_modules", "pi-voicekit");
{
	const relRoot = path.join(os.homedir(), ".pi", "agent", "install", "releases");
	const extra = [];
	for (const v of fs.readdirSync(relRoot).sort().reverse()) extra.push(path.join(relRoot, v, "node_modules"));
	// _initPaths() rebuilds globalPaths from NODE_PATH, so set the env first.
	process.env.NODE_PATH = [...(process.env.NODE_PATH ? [process.env.NODE_PATH] : []), ...extra].join(path.delimiter);
	Module._initPaths();
}
const require = Module.createRequire(path.join(NPM, "noop.cjs"));
const jiti = require("jiti")(import.meta.filename);
const TEXT = "The quick brown fox jumps over the lazy dog, then stops to think.";

const ROLE = process.env.ROLE ?? "";
if (ROLE === "safe-order" || ROLE === "raw-sherpa") {
	// Import order here mirrors pi: the TTS modules must NOT be imported first,
	// otherwise tts-paradee's own import-time prime would mask whether the
	// loadSherpa() prime actually works.
	const sherpaEngine = jiti(path.join(PKG, "extensions", "voice", "sherpa-engine.ts"));
	if (ROLE === "raw-sherpa") {
		require("sherpa-onnx-node"); // bypasses loadSherpa(), i.e. a third party loads it
	} else {
		assert.equal(await sherpaEngine.initSherpa(), true, "initSherpa() must succeed");
		const ortPath = require.resolve("onnxruntime-node");
		assert.ok(require.cache[ortPath], "loadSherpa() must leave onnxruntime-node resident (the prime)");
		console.log("1. initSherpa() ran first (TTS modules untouched) and left onnxruntime-node resident");
	}

	const eng = jiti(path.join(PKG, "extensions", "voice", "tts-engine.ts"));
	const cat = jiti(path.join(PKG, "extensions", "voice", "tts-local-models.ts"));

	const run = async (id, min) => {
		const audio = await eng.synthesize({
			text: TEXT,
			model: cat.getTtsModel(id),
			modelDir: cat.getInstalledTtsModelDir(id),
			language: "en",
		});
		assert.ok(audio.samples.length > min, `${id} produced no audio (${audio.samples.length})`);
		return `${audio.samples.length} samples @ ${audio.sampleRate} Hz`;
	};

	if (ROLE === "raw-sherpa") {
		try {
			await run("paradee-8m-v1_2", 50000);
			console.log("UNEXPECTED: Paradee loaded even after a raw sherpa require()");
			process.exit(1);
		} catch (err) {
			const m = String(err?.message ?? err);
			const good = /already has a different copy resident/.test(m);
			console.log(good ? "2. raw-sherpa order → honest load-order message (not \"not installed\")" : "2. WRONG message");
			console.log("   " + m.replace(/\s+/g, " ").slice(0, 180));
			process.exit(good ? 0 : 1);
		}
	}

	console.log(`2. sherpa backend real inference: ${await run("kitten-nano-en-v0_2", 20000)}`);
	console.log(`3. paradee backend real inference: ${await run("paradee-8m-v1_2", 50000)}`);
	console.log("SAFE ORDER (pi's order) — BOTH ONNX RUNTIMES COEXIST: PASS");
	process.exit(0);
}

// ── parent: run both children, assert both verdicts ──────────────────────────
const child = (role) => {
	const r = spawnSync(process.execPath, [import.meta.filename], {
		env: { ...process.env, ROLE: role },
		encoding: "utf8",
		timeout: 240000,
	});
	const out = (r.stdout ?? "") + (r.stderr ?? "");
	return { code: r.status, out };
};

const safe = child("safe-order");
assert.equal(safe.code, 0, `safe-order child failed:\n${safe.out.slice(-1200)}`);
assert.ok(/BOTH ONNX RUNTIMES COEXIST: PASS/.test(safe.out), safe.out.slice(-600));
console.log(safe.out.trim().split("\n").join("\n"));

const raw = child("raw-sherpa");
assert.equal(raw.code, 0, `raw-sherpa child failed:\n${raw.out.slice(-800)}`);
assert.ok(/honest load-order message/.test(raw.out), raw.out.slice(-600));
console.log(raw.out.trim().split("\n").join("\n"));
console.log("LOAD ORDER — PASS");
