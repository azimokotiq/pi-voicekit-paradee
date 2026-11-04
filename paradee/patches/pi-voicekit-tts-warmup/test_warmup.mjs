// Self-test for the TTS warmup patch (pi-voicekit-tts-warmup).
//
// Proves three things about the INSTALLED voice.ts:
//   1. wiring — the helper exists, is called at session_start, on TTS enable
//      and on settings save, and is the only caller of warmupTts() (which
//      upstream exports but never invokes).
//   2. gating — disabled TTS / cloud backend / unknown model do no work.
//   3. effect — after warmupSelectedTts() returns true, a real synthesize() of
//      a full sentence is far faster than the unwarmed first utterance, i.e.
//      the model really is resident and the user never pays that load.
//
// Run: node ~/.pi/agent/patches/pi-voicekit-tts-warmup/test_warmup.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Module from "node:module";
import assert from "node:assert";

const NPM = path.join(os.homedir(), ".pi", "agent", "npm");
const PKG = path.join(NPM, "node_modules", "pi-voicekit");
const VOICE_TS = path.join(PKG, "extensions", "voice.ts");

// Same NODE_PATH bootstrap as the other patch self-tests: pi's packages live
// under the installed release's node_modules and the harness shell does not
// always export NODE_PATH. _initPaths() rebuilds globalPaths from NODE_PATH,
// so set the env first.
{
	const relRoot = path.join(os.homedir(), ".pi", "agent", "install", "releases");
	const extra = [];
	try {
		for (const v of fs.readdirSync(relRoot).sort().reverse()) extra.push(path.join(relRoot, v, "node_modules"));
	} catch {}
	process.env.NODE_PATH = [...(process.env.NODE_PATH ? [process.env.NODE_PATH] : []), ...extra].join(path.delimiter);
	if (typeof Module._initPaths === "function") Module._initPaths();
}

const require = Module.createRequire(path.join(NPM, "noop.cjs"));
const jiti = require("jiti")(import.meta.filename);

// ─── 1. wiring (static, against the installed file) ──────────────────────────
const src = fs.readFileSync(VOICE_TS, "utf8");
const helperDefs = (src.match(/export async function warmupSelectedTts/g) ?? []).length;
assert.equal(helperDefs, 1, "warmupSelectedTts must be defined exactly once");
for (const [label, re] of [
	["session_start call", /warmupSelectedTts\(\(\) => config, "session_start"\)/],
	["enable call", /warmupSelectedTts\(\(\) => config, "speak-toggle"\)/],
	["settings-save call", /warmupSelectedTts\(\(\) => config, "settings-save"\)/],
	["the upstream warmup is now invoked", /await warmupTts\(/],
]) {
	assert.ok(re.test(src), `voice.ts must contain the ${label}`);
}
// voice.ts must be the only caller of the exported warmupTts — otherwise the
// patch duplicates a warmup upstream already schedules. Line-based: a bare
// substring match also fires on doc comments and on the definition itself.
const engineSrc = fs.readFileSync(path.join(PKG, "extensions", "voice", "tts-engine.ts"), "utf8");
assert.ok(
	/export async function warmupTts/.test(engineSrc),
	"tts-engine.ts must still export warmupTts (upstream symbol)"
);
const engineCalls = engineSrc
	.split("\n")
	.map((l) => l.trim())
	.filter(
		(l) =>
			/warmupTts\s*\(/.test(l) &&
			!l.startsWith("*") &&
			!l.startsWith("//") &&
			!/^export (async )?function warmupTts/.test(l)
	).length;
assert.equal(engineCalls, 0, "tts-engine.ts must not call warmupTts itself");

// ─── 2. gating (behaviour, through the real export) ─────────────────────────
const voice = jiti(VOICE_TS);
assert.equal(typeof voice.warmupSelectedTts, "function", "warmupSelectedTts must be exported");

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf8"));
const vcfg = settings.voice ?? {};
const modelId = vcfg.ttsLocalModel || "kitten-nano-en-v0_2";

assert.equal(
	await voice.warmupSelectedTts(() => ({ ttsEnabled: false, ttsLocalModel: modelId }), "self-test/off"),
	false,
	"must do nothing when TTS is disabled"
);
assert.equal(
	await voice.warmupSelectedTts(
		() => ({ ttsEnabled: true, ttsBackend: "deepgram", ttsLocalModel: modelId }),
		"self-test/cloud"
	),
	false,
	"must do nothing for a cloud backend (nothing local to warm)"
);
assert.equal(
	await voice.warmupSelectedTts(
		() => ({ ttsEnabled: true, ttsBackend: "local", ttsLocalModel: "definitely-not-a-model-xyz" }),
		"self-test/bogus"
	),
	false,
	"must not throw for an unknown model id"
);

const { isTtsModelInstalled } = jiti(path.join(PKG, "extensions", "voice", "tts-local-models.ts"));
if (!isTtsModelInstalled(modelId)) {
	console.log(`self-test: model ${modelId} is not installed — gating checks passed, skipping the timing half`);
	process.exit(0);
}

// ─── 3. effect (real model, real inference) ─────────────────────────────────
const t0 = Date.now();
const ok = await voice.warmupSelectedTts(
	() => ({ ttsEnabled: true, ttsBackend: "local", ttsLocalModel: modelId, ttsLocalVoiceId: vcfg.ttsLocalVoiceId }),
	"self-test"
);
const warmMs = Date.now() - t0;
assert.equal(ok, true, `warmup must succeed for installed model ${modelId}`);

assert.equal(
	await voice.warmupSelectedTts(
		() => ({ ttsEnabled: true, ttsBackend: "local", ttsLocalModel: modelId }),
		"self-test/again"
	),
	false,
	"a second call for the same model must be a no-op (Set keyed on model id)"
);

const { synthesize } = jiti(path.join(PKG, "extensions", "voice", "tts-engine.ts"));
const { getTtsModel, getInstalledTtsModelDir } = jiti(path.join(PKG, "extensions", "voice", "tts-local-models.ts"));
const sentence =
	"Warming the engine at session start means the first thing you hear is speech, not a pause while a model loads.";
const t1 = Date.now();
const audio = await synthesize({
	text: sentence,
	model: getTtsModel(modelId),
	modelDir: getInstalledTtsModelDir(modelId),
	language: "en",
	sid: Number.isFinite(vcfg.ttsLocalVoiceId) ? vcfg.ttsLocalVoiceId : getTtsModel(modelId).defaultSid,
	speed: 1,
});
const synthMs = Date.now() - t1;
assert.ok(audio?.samples?.length > 2000, "warmup must leave a usable engine (expected audio output)");
// Unwarmed first utterance measured 4111 ms (paradee-8m-v1_0) / ~1.9 s (kokoro-int8).
assert.ok(
	synthMs < 1500,
	`first synthesize after warmup took ${synthMs} ms — warmup did not make the engine resident`
);
console.log(
	`  ✓ warmupSelectedTts() warm (model resident, includes ONNX session + G2P): ${warmMs} ms`
);
console.log(
	`  ✓ first synthesize() after warmup: ${audio.samples.length} samples, ${synthMs} ms ` +
		`(unwarmed first utterance measured 4111 ms for this model)`
);
