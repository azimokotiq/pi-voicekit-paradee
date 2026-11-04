// Paradee-8M end-to-end probe: eSpeak(js) phonemes -> misaki table -> token ids -> ONNX -> wav.
// Proves the pipeline works on Windows and measures RTF against the kokoro/kitten numbers.
// Run: node ~/ttsdbg/probe_paradee.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(path.join(os.homedir(), ".pi", "agent", "npm", "noop.cjs"));
const ort = require("onnxruntime-node");
const { phonemize } = require("phonemizer");
const { toMisaki } = await import(pathToFileURL(path.join(os.homedir(), "ttsdbg", "misaki.js")).href);

const DIR = path.join(os.homedir(), ".pi", "models", "tts", "paradee-8m-v1_0");
const vocab = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8")).vocab;
const SR = 24000;
const MAX = 510;
const t = () => Number(process.hrtime.bigint() / 1_000_000n);

async function makeSession(threads) {
	const so = { intraOpNumThreads: threads, interOpNumThreads: 1, logSeverityLevel: 3 };
	const lt = t();
	const s = await ort.InferenceSession.create(path.join(DIR, "paradee_int8.onnx"), so);
	return { s, loadMs: t() - lt, inputs: s.inputNames, outputs: s.outputNames };
}

function toIds(phonemes) {
	const ids = [];
	const dropped = new Set();
	for (const c of phonemes) {
		const id = vocab[c];
		if (id === undefined) {
			dropped.add(c);
			continue;
		}
		ids.push(id);
		if (ids.length >= MAX) break;
	}
	return { ids: [0, ...ids, 0], dropped: [...dropped] };
}

async function synth(s, phonemes, speed = 1.0) {
	const { ids, dropped } = toIds(phonemes);
	const feeds = {
		input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
		speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
	};
	const t0 = t();
	const out = await s.run(feeds);
	const wave = out[s.outputNames[0]].data;
	return { ms: t() - t0, dur: wave.length / SR, wave: Float32Array.from(wave), dropped };
}

function writeWav(file, samples, sr) {
	const buf = Buffer.alloc(44 + samples.length * 2);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + samples.length * 2, 4);
	// Canonical 44-byte header: RIFF/size/WAVE at 0-11, then "fmt " at 12 with its
	// SIZE at 16 and payload 20-35. (Writing the size at 12 clobbers the chunk id,
	// which is what made sherpa report in_sample_rate: 0 and crash.)
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // mono
	buf.writeUInt32LE(sr, 24);
	buf.writeUInt32LE(sr * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(samples.length * 2, 40);
	let peak = 0;
	for (let i = 0; i < samples.length; i++) {
		const v = Math.max(-1, Math.min(1, samples[i]));
		peak = Math.max(peak, Math.abs(v));
		buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
	}
	fs.writeFileSync(file, buf);
	return peak;
}

const S1 = "Your microphone is fixed now, and it was never a permissions problem at all.";
const S2 = "The extension asked DirectShow for a device that does not exist on Windows.";
const S3 = "Restart pi and try push to talk again with the usual shortcut.";
const S4 = "Input gain is low, so raising the Windows mic level gives the model more headroom.";

const g2pCache = new Map();
async function phonemes(text) {
	if (g2pCache.has(text)) return g2pCache.get(text);
	const parts = await phonemize(text, "en-us");
	const raw = parts.join(" ");
	const mis = toMisaki(raw);
	g2pCache.set(text, { raw, mis });
	return g2pCache.get(text);
}

for (const threads of [1, 4]) {
	const { s, loadMs, inputs, outputs } = await makeSession(threads);
	if (threads === 1) console.log(`session inputs=${JSON.stringify(inputs)} outputs=${JSON.stringify(outputs)} load ${loadMs} ms`);
	console.log(`\nthreads=${threads}`);
	for (const text of ["Yes.", S1, S1 + " " + S2, S1 + " " + S2 + " " + S3 + " " + S4]) {
		const g = await phonemes(text);
		const r = await synth(s, g.mis);
		console.log(
			`  ${String(text.length).padStart(4)} ch → ${String(r.ms).padStart(5)} ms, audio ${r.dur.toFixed(2)} s, RTF ${(r.ms / 1000 / r.dur).toFixed(3)}${r.dropped.length ? ` dropped=${JSON.stringify(r.dropped)}` : ""}`,
		);
		if (threads === 1) {
			if (text === "Yes.") console.log(`    g2p raw=${JSON.stringify(g.raw)} misaki=${JSON.stringify(g.mis)}`);
			const peak = writeWav(path.join(os.homedir(), "ttsdbg", `paradee_${text.length}ch.wav`), r.wave, SR);
			console.log(`    wav peak=${peak.toFixed(3)} samples=${r.wave.length}`);
		}
	}
	if (typeof s.release === "function") await s.release();
}
