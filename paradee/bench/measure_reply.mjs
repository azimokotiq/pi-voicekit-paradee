// Measure the REAL pipeline the extension uses, for a real reply length:
// model load (what the warmup patch pays at session start) + per-utterance
// synthesis through synthesize() in the installed, patched pi-voicekit.
// Uses jiti because Node refuses to type-strip .ts inside node_modules — the
// same loader trick as the patch self-tests.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Module from "node:module";

const NPM = path.join(os.homedir(), ".pi", "agent", "npm");
const PKG = path.join(NPM, "node_modules", "pi-voicekit");

// pi's own node_modules (jiti) live in the installed release; NODE_PATH is not
// reliable across shells, so add the release roots to the CJS global paths.
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
const jiti = require("jiti")(path.join(PKG, "extensions", "voice.ts"));

const eng = jiti(path.join(PKG, "extensions", "voice", "tts-engine.ts"));
const models = jiti(path.join(PKG, "extensions", "voice", "tts-local-models.ts"));

const ID = "paradee-8m-v1_0";
const model = models.getTtsModel(ID);
const dir = models.getInstalledTtsModelDir(ID);
if (!model || !dir) {
	console.log(JSON.stringify({ error: "paradee model not resolvable", model: !!model, dir }));
	process.exit(1);
}

const REPLY =
	"Mic fixed, Esc fixed, and Paradee is the voice now, about nine times faster than Kokoro. " +
	"Press space and talk. That sentence you just heard is the measurement.";

const t0 = Date.now();
const warmed = await eng.warmupTts(model, dir);
const loadMs = Date.now() - t0;

const runs = [];
let first;
for (let i = 0; i < 3; i++) {
	const t = Date.now();
	const r = await eng.synthesize({ text: REPLY, model, modelDir: dir, sid: 0, speed: 1.25, language: "en" });
	runs.push(Date.now() - t);
	if (!first) first = r;
}

const audioSec = first.samples.length / first.sampleRate;
const nan = first.samples.some((s) => !Number.isFinite(s));

console.log(
	JSON.stringify(
		{
			chars: REPLY.length,
			modelLoadMs: loadMs,
			warmupOk: warmed,
			synthRunsMs: runs,
			audioSeconds: +audioSec.toFixed(2),
			firstUtteranceTotalMs: loadMs + runs[0],
			rtfWarm: +(runs[1] / audioSec).toFixed(3),
			sampleRate: first.sampleRate,
			anyNaN: nan,
		},
		null,
		1
	)
);
