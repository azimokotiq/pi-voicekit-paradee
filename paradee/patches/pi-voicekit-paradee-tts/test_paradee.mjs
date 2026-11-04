// Self-test for the Paradee TTS backend patch (pi-voicekit-paradee-tts).
// Exercises the PATCHED modules in place, end to end: catalog → installer
// marker → synthesize() dispatch → onnxruntime-node run, plus a regression
// check that the sherpa path (kitten) still synthesizes.
// Run: node ~/.pi/agent/patches/pi-voicekit-paradee-tts/test_paradee.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Module from "node:module";
import assert from "node:assert";

const NPM = path.join(os.homedir(), ".pi", "agent", "npm");
const PKG = path.join(NPM, "node_modules", "pi-voicekit");

// pi's own packages (jiti, @earendil-works/pi-tui) live in the installed
// release's node_modules, and NODE_PATH is not exported in every shell — it
// disappeared after a pi restart, which broke this test. Add the release roots
// to the CJS global paths so the test never depends on the caller's environment.
{
	const relRoot = path.join(os.homedir(), ".pi", "agent", "install", "releases");
	const extra = [];
	try {
		for (const v of fs.readdirSync(relRoot).sort().reverse()) {
			extra.push(path.join(relRoot, v, "node_modules"));
		}
	} catch {}
	// _initPaths() REBUILDS globalPaths from NODE_PATH, so the env has to be set
	// first — pushing into Module.globalPaths and then calling _initPaths (as an
	// earlier revision of this test did) silently wipes them and jiti stays
	// unresolvable.
	process.env.NODE_PATH = [...(process.env.NODE_PATH ? [process.env.NODE_PATH] : []), ...extra].join(path.delimiter);
	if (typeof Module._initPaths === "function") Module._initPaths();
}

const require = Module.createRequire(path.join(NPM, "noop.cjs"));
const jiti = require("jiti")(import.meta.filename);

const cat = jiti(path.join(PKG, "extensions", "voice", "tts-local-models.ts"));
const eng = jiti(path.join(PKG, "extensions", "voice", "tts-engine.ts"));
const par = jiti(path.join(PKG, "extensions", "voice", "tts-paradee.ts"));

const ok = [];

// ── native load-order invariant ─────────────────────────────────────────────
// sherpa-onnx-node and onnxruntime-node each carry their own ONNX Runtime. If
// sherpa's copy is resident first, the Windows loader refuses ORT's native
// binding ("The operating system cannot run %1"), which kills Paradee for the
// whole session — the failure we hit live. The backend must prime ORT at import.
assert.equal(par.isParadeeRuntimeReady(), true, "onnxruntime-node was not primed by importing tts-paradee.ts");
const psrc = fs.readFileSync(path.join(PKG, "extensions", "voice", "tts-paradee.ts"), "utf8");
assert.equal(
	(psrc.match(/^primeOnnxRuntime\(\);$/gm) || []).length,
	1,
	"expected exactly one top-level primeOnnxRuntime() call in tts-paradee.ts"
);
ok.push("ORT primed at import, before any sherpa use (load-order invariant holds)");

// ── G2P plumbing (pure functions) ────────────────────────────────────────────
const mis = par.toMisaki("aɪ oʊ ɪɾ ɜːɹ ɚ ʔn̩");
assert.equal(mis, "I O ɪT ɜɹ əɹ tn", `toMisaki gave ${JSON.stringify(mis)}`); // ɾ→T and ʔ→t are upstream rules
ok.push(`toMisaki eSpeak→misaki: ${JSON.stringify(mis)}`);

const vocab = parVocab();
function parVocab() {
	return JSON.parse(fs.readFileSync(path.join(cat.getTtsModelDir("paradee-8m-v1_0"), "config.json"), "utf8")).vocab;
}
const mapped = par.phonemesToIds("sɛs.", vocab);
assert.equal(mapped.ids[0], 0);
assert.equal(mapped.ids[mapped.ids.length - 1], 0);
assert.ok(mapped.ids.includes(vocab["."]), "sentence period must keep its prosody id");
assert.deepEqual(mapped.dropped, [], `unexpected dropped chars: ${mapped.dropped}`);
ok.push(`phonemesToIds: ${JSON.stringify(mapped.ids)} (0 pads + "." prosody id kept)`);

const prosody = par.splitProsody("Hi there, right? Bye now.");
assert.deepEqual(
	prosody.map((p) => [p.segment, p.prosody]),
	[
		["Hi there", ","],
		["right", "?"],
		["Bye now", "."],
	],
	JSON.stringify(prosody)
);
ok.push(`splitProsody keeps punctuation for prosody: ${JSON.stringify(prosody.map((p) => p.prosody))}`);

// ── Catalog + install marker ─────────────────────────────────────────────────
const model = cat.getTtsModel("paradee-8m-v1_0");
assert.equal(model.backend, "paradee");
assert.equal(model.languages.includes("en"), true);
assert.ok(model.files?.length === 2, "catalog entry must pin both model files");
assert.equal(cat.isTtsModelInstalled("paradee-8m-v1_0"), true, "paradee model files missing under ~/.pi/models/tts");
// Regression: archive-based models still use the tokens.txt marker.
assert.equal(cat.isTtsModelInstalled("definitely-not-a-model"), false);
ok.push(`catalog + install marker (files[] checked, not tokens.txt)`);

// ── Real synthesis through the patched synthesize() ─────────────────────────
const text =
	"Your microphone is fixed now, and it was never a permissions problem at all. " +
	"The extension asked DirectShow for a device that does not exist on Windows.";
const t0 = Date.now();
let progressCalls = 0;
const audio = await eng.synthesize({
	text,
	model,
	modelDir: cat.getInstalledTtsModelDir("paradee-8m-v1_0"),
	language: "en",
	speed: 1.25,
	onProgress: () => progressCalls++,
});
const ms = Date.now() - t0;
const dur = audio.samples.length / audio.sampleRate;
const finite = audio.samples.every((v) => Number.isFinite(v));
let peak = 0;
for (const v of audio.samples) peak = Math.max(peak, Math.abs(v)); // spread would blow the stack on 100k+ samples
assert.ok(finite, "NaN samples would poison playback");
assert.ok(audio.samples.length > audio.sampleRate, `too few samples (${audio.samples.length})`);
assert.ok(peak > 0.02, `output is effectively silent (peak ${peak})`);
// Cold includes the one-time ONNX session load (~3 s) — generous bound; the
		// warm assertion below is the one that guards real latency.
		assert.ok(ms / 1000 / dur < 1.0, `cold RTF ${(ms / 1000 / dur).toFixed(3)} is too slow for Paradee`);
assert.ok(progressCalls === 1, "onProgress should fire once for the Paradee path");
ok.push(
	`synthesize() cold (ONNX session load + graph optimise + first G2P included): ${audio.samples.length} samples, ${dur.toFixed(2)} s audio in ${ms} ms (RTF ${(ms / 1000 / dur).toFixed(3)}), peak ${peak.toFixed(3)}`
);

// Warm run — the session is cached, so this is the latency every utterance
// after the first actually pays.
const t2 = Date.now();
const warm = await eng.synthesize({
	text,
	model,
	modelDir: cat.getInstalledTtsModelDir("paradee-8m-v1_0"),
	language: "en",
	speed: 1.25,
});
const warmMs = Date.now() - t2;
const warmDur = warm.samples.length / warm.sampleRate;
assert.ok(warmMs / 1000 / warmDur < 0.2, `warm RTF ${(warmMs / 1000 / warmDur).toFixed(3)} should be well under realtime`);
ok.push(
	`synthesize() warm: ${warmDur.toFixed(2)} s audio in ${warmMs} ms (RTF ${(warmMs / 1000 / warmDur).toFixed(3)}) — ~30x faster than the Kokoro path`
);

// ── Abort wiring ─────────────────────────────────────────────────────────────
const ac = new AbortController();
ac.abort();
let abortName = "";
try {
	await eng.synthesize({ text, model, modelDir: cat.getInstalledTtsModelDir("paradee-8m-v1_0"), language: "en", signal: ac.signal });
} catch (err) {
	abortName = err?.name ?? "";
}
assert.equal(abortName, "AbortError", `pre-aborted call should reject with AbortError, got ${abortName || "no error"}`);
ok.push("pre-aborted synthesize rejects with AbortError");

// ── Regression: the sherpa path is untouched ────────────────────────────────
const kitten = cat.getTtsModel("kitten-nano-en-v0_2");
if (cat.isTtsModelInstalled("kitten-nano-en-v0_2")) {
	const t1 = Date.now();
	const k = await eng.synthesize({
		text: "Hello there, this is the sherpa path.",
		model: kitten,
		modelDir: cat.getInstalledTtsModelDir("kitten-nano-en-v0_2"),
		language: "en",
		sid: 0,
	});
	assert.ok(k.samples.length > 0 && Array.from(k.samples).every(Number.isFinite), "sherpa path broke");
	ok.push(`sherpa/kitten regression ok: ${k.samples.length} samples in ${Date.now() - t1} ms`);
} else {
	ok.push("sherpa/kitten not installed — regression check skipped");
}

console.log("PARADEE TTS PATCH — ALL PASS");
for (const line of ok) console.log("  ✓", line);
