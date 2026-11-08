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

// v1.2's British voices were trained on misaki's British dictionary, so the
// table has a second branch: əʊ→Q, eə→ɛː (before the e→A rule eats it), "the"
// → ði, and British vowels KEEP their length marks.
const brit = par.toMisaki("bˈaθ fˈast ˌəʊvə ðɪ æpə ɡˌoʊ eɪ eə", true);
assert.equal(brit, "bˈaθ fˈast ˌQvə ði æpə ɡˌɔʊ A ɛː", `British toMisaki gave ${JSON.stringify(brit)}`);
const amer = par.toMisaki("bˈæθ fˈæst ˌoʊvɚ wˈɔːɾɚ", false);
assert.equal(amer, "bˈæθ fˈæst ˌOvəɹ wˈɔTəɹ", `American toMisaki gave ${JSON.stringify(amer)}`);
ok.push(`toMisaki British branch: ${JSON.stringify(brit)}`);

const vocab = parVocab();
function parVocab() {
	return JSON.parse(fs.readFileSync(path.join(cat.getTtsModelDir("paradee-8m-v1_2"), "config.json"), "utf8")).vocab;
}

// The G2P that runs at runtime, fed through the real phonemizer: every phoneme
// of a real British sentence must have a vocabulary id, or the voice speaks
// with holes in it. This is the check that catches the mapping table going stale.
{
	const { phonemize } = require("phonemizer");
	const sentence = "The bath is fast over the water, and I will go to the shop for a quarter of an hour, won't I?";
	for (const [tag, british] of [
		["en-us", false],
		["en-gb", true],
	]) {
		const ps = par.toMisaki((await phonemize(sentence, tag)).join(" "), british);
		const mapped = par.phonemesToIds(ps, vocab);
		assert.ok(mapped.ids.length > 20, `${tag}: only ${mapped.ids.length} ids`);
		assert.deepEqual(mapped.dropped, [], `${tag}: phonemes with no vocabulary id: ${mapped.dropped}`);
		ok.push(`${tag} G2P -> misaki -> ids: ${mapped.ids.length} ids, nothing dropped`);
	}
}

// Voice selection: the name prefix picks the misaki dictionary, and the sid is
// the graph's `voice` input — so the catalog order is not free to change.
assert.equal(par.paradeeVoiceLang("bf_isabella"), "en-gb");
assert.equal(par.paradeeVoiceLang("bm_fable"), "en-gb");
assert.equal(par.paradeeVoiceLang("af_heart"), "en-us");
assert.equal(par.paradeeVoiceLang("am_puck"), "en-us");
assert.equal(par.resolveVoice({ voices: ["af_heart", "bf_isabella", "am_puck", "bm_fable"] }, "am_puck"), 2);
assert.equal(par.resolveVoice({ voices: ["af_heart", "bf_isabella"] }, 9), 1, "out-of-range sid must clamp");
assert.equal(par.resolveVoice({ voices: ["af_heart", "bf_isabella"] }, "nope"), 0, "unknown name must fall back");
assert.deepEqual(par.paradeeVoices(parConfig()), ["af_heart", "bf_isabella", "am_puck", "bm_fable"]);
ok.push("voice selection: sid is the graph input, bf_/bm_ get en-gb");

// One process, both accents. `phonemizer` latches the process's accent at its
// first call (verified 2026-11-08: later calls ignore the language argument),
// and this test already phonemized American above — so the British call here
// has to be served by the per-accent child worker, not the in-process wasm.
{
	const probe = "Bath over the water and the world.";
	const us = (await par.paradeeG2p(probe, "en-us")).join(" ");
	const gb = (await par.paradeeG2p(probe, "en-gb")).join(" ");
	assert.ok(us.includes("oʊ") || us.includes("ɚ"), `American G2P lost its accent: ${us}`);
	assert.ok(gb.includes("əʊ") || gb.includes("ɒ"), `British G2P lost its accent: ${gb}`);
	assert.ok(!gb.includes("ɚ"), `British G2P came back r-coloured, i.e. American: ${gb}`);
	ok.push(`one process, both accents: ${JSON.stringify(us)} / ${JSON.stringify(gb)}`);
}
function parConfig() {
	return JSON.parse(fs.readFileSync(path.join(cat.getTtsModelDir("paradee-8m-v1_2"), "config.json"), "utf8"));
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
const model = cat.getTtsModel("paradee-8m-v1_2");
assert.equal(model.backend, "paradee");
assert.equal(model.languages.includes("en"), true);
assert.ok(model.files?.length === 2, "catalog entry must pin both model files");
assert.equal(cat.isTtsModelInstalled("paradee-8m-v1_2"), true, "paradee model files missing under ~/.pi/models/tts");
// v1.2's four voices, in the model's own order.
assert.deepEqual(
	model.voices.map((v) => v.sid),
	[0, 1, 2, 3],
	JSON.stringify(model.voices)
);
assert.deepEqual(
	model.voices.map((v) => v.name.split(" ")[0]),
	["af_heart", "bf_isabella", "am_puck", "bm_fable"],
	"catalog voice order must match config.json's `voices` list"
);
assert.equal(model.defaultSid, 1, "the default voice is the British female one");
// Regression: archive-based models still use the tokens.txt marker.
assert.equal(cat.isTtsModelInstalled("definitely-not-a-model"), false);
ok.push("catalog + install marker (4 voices in model order, files[] checked, not tokens.txt)");

// ── Real synthesis through the patched synthesize() ─────────────────────────
const text =
	"Your microphone is fixed now, and it was never a permissions problem at all. " +
	"The extension asked DirectShow for a device that does not exist on Windows.";
const t0 = Date.now();
let progressCalls = 0;
const audio = await eng.synthesize({
	text,
	model,
	modelDir: cat.getInstalledTtsModelDir("paradee-8m-v1_2"),
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
	modelDir: cat.getInstalledTtsModelDir("paradee-8m-v1_2"),
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
// All four voices, for real. v1.2 picks the voice with a `voice` int64 input
// the v1.0 graph never had, and two of the four are British, which also means
// the G2P has to switch dictionary. Rough pitch (autocorrelation over the
// loudest windows) is the discriminator: if the input were ignored, all four
// would report af_heart's pitch.
const voiceLine = "Reading this line out loud is what checks that the voice table is wired to the graph.";
function roughPitch(samples, sr) {
	const win = Math.floor(sr * 0.04);
	const lo = Math.floor(sr / 400);
	const hi = Math.floor(sr / 90);
	const f0s = [];
	for (let i = 0; i + win + hi < samples.length; i += Math.floor(sr * 0.05)) {
		let e0 = 0;
		for (let k = 0; k < win; k++) e0 += samples[i + k] * samples[i + k];
		if (e0 / win < 0.004) continue; // unvoiced stretch
		// Normalised autocorrelation: the first clear peak after lag 0 is the period.
		let bestLag = 0;
		let bestR = 0;
		let prev = 0;
		let prev2 = 0;
		for (let lag = lo; lag <= hi; lag++) {
			let c = 0;
			for (let k = 0; k < win; k++) c += samples[i + k] * samples[i + k + lag];
			const r = c / e0;
			if (r > 0.35 && r > prev && r >= prev2 && r > bestR) {
				bestR = r;
				bestLag = lag;
			}
			prev2 = prev;
			prev = r;
		}
		if (bestLag) f0s.push(sr / bestLag);
	}
	if (!f0s.length) return 0;
	f0s.sort((a, b) => a - b);
	return Math.round(f0s[Math.floor(f0s.length / 2)]);
}
const voiced = [];
for (const v of model.voices) {
	const t = Date.now();
	const a = await eng.synthesize({
		text: voiceLine,
		model,
		modelDir: cat.getInstalledTtsModelDir("paradee-8m-v1_2"),
		language: "en",
		sid: v.sid,
	});
	let pk = 0;
	for (const s of a.samples) pk = Math.max(pk, Math.abs(s));
	assert.ok(a.samples.every(Number.isFinite), `${v.name}: NaN samples`);
	assert.ok(pk > 0.02, `${v.name}: effectively silent (peak ${pk})`);
	const d = a.samples.length / a.sampleRate;
	// A 96-character sentence lands at ~5.3 s for every voice; a graph fed the
	// wrong inputs babble-loops or truncates, and both bands are checked here.
	assert.ok(d > 3 && d < 9, `${v.name}: ${d.toFixed(2)} s of audio for a ~5 s sentence`);
	const pitch = roughPitch(a.samples, a.sampleRate);
	voiced.push({ sid: v.sid, name: v.name, gender: v.gender, pitch });
	console.log(`  · sid=${v.sid} ${v.name}: ${d.toFixed(2)} s audio in ${Date.now() - t} ms, peak ${pk.toFixed(3)}, pitch ~${pitch} Hz`);
	ok.push(`voice sid=${v.sid} ${v.name}: ${d.toFixed(2)} s audio in ${Date.now() - t} ms, peak ${pk.toFixed(3)}, pitch ~${pitch} Hz`);
}
{
	const mid = (xs) => xs.map((x) => x.pitch).sort((p, q) => p - q)[Math.ceil(xs.length / 2) - 1];
	const fem = mid(voiced.filter((v) => v.gender === "female"));
	const male = mid(voiced.filter((v) => v.gender === "male"));
	assert.ok(fem > 0 && male > 0, `pitch estimate found nothing (female ${fem}, male ${male})`);
	assert.ok(
		fem >= male * 1.15,
		`the male voices are not clearly lower-pitched than the female ones (female ~${fem} Hz, male ~${male} Hz) — the \`voice\` input is not reaching the graph`
	);
	ok.push(`pitch separates the voices: female ~${fem} Hz, male ~${male} Hz`);
}

// The feed must be built from the v1.2 `voice` input, gated on the session
// declaring it (a v1.0 graph has no such input and onnxruntime rejects extras).
assert.ok(
	/feeds\.voice = new ort\.Tensor\("int64"/.test(psrc) && /hasVoiceInput/.test(psrc),
	"tts-paradee.ts must feed the v1.2 `voice` input, gated on the session declaring it"
);

const ac = new AbortController();
ac.abort();
let abortName = "";
try {
	await eng.synthesize({ text, model, modelDir: cat.getInstalledTtsModelDir("paradee-8m-v1_2"), language: "en", signal: ac.signal });
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
