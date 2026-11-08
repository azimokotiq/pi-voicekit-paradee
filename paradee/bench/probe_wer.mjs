// Objective intelligibility check on the Paradee WAVs: transcribe with the SAME local
// ASR pi-voicekit uses (parakeet-v3 transducer) and score WER against the source text.
// Run: node paradee/bench/probe_wer.mjs > paradee/bench/wer.txt
// (the wavs it scores are probe_paradee.mjs's output, next to this script)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(path.join(os.homedir(), ".pi", "agent", "npm", "noop.cjs"));
const sherpa = require("sherpa-onnx-node");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(os.homedir(), ".pi", "models", "parakeet-v3");

function readWav(file) {
	const b = fs.readFileSync(file);
	let off = 12, sr = 0, ch = 1, bits = 16, dataOff = -1, dataLen = 0;
	while (off + 8 <= b.length) {
		const id = b.toString("ascii", off, off + 4), len = b.readUInt32LE(off + 4);
		if (id === "fmt ") { ch = b.readUInt16LE(off + 10); sr = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
		else if (id === "data") { dataOff = off + 8; dataLen = Math.min(len, b.length - off - 8); }
		off += 8 + len + (len % 2);
	}
	const samples = new Float32Array(dataLen / (bits / 8));
	for (let i = 0; i < samples.length; i++) samples[i] = b.readInt16LE(dataOff + i * 2) / 32768;
	return { sr, samples };
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
	const r = norm(ref), h = norm(hyp);
	const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
	for (let j = 0; j <= h.length; j++) d[0][j] = j;
	for (let i = 1; i <= r.length; i++)
		for (let j = 1; j <= h.length; j++)
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
	return { werPct: (100 * d[r.length][h.length]) / r.length, refWords: r.length, hypWords: h.length };
}

const rec = new sherpa.OfflineRecognizer({
	featConfig: { sampleRate: 16000, featureDim: 80 },
	modelConfig: {
		transducer: { encoder: path.join(DIR, "encoder.int8.onnx"), decoder: path.join(DIR, "decoder.int8.onnx"), joiner: path.join(DIR, "joiner.int8.onnx") },
		tokens: path.join(DIR, "tokens.txt"),
		numThreads: 4,
		provider: "cpu",
		modelType: "nemo_transducer",
	},
});

const LONG =
	"Your microphone is fixed now, and it was never a permissions problem at all. The extension asked DirectShow for a device that does not exist on Windows. Restart pi and try push to talk again with the usual shortcut. Input gain is low, so raising the Windows mic level gives the model more headroom.";
const MID =
	"Your microphone is fixed now, and it was never a permissions problem at all. The extension asked DirectShow for a device that does not exist on Windows.";
const CASES = [
	["paradee_152ch.wav", MID],
	["paradee_298ch.wav", LONG],
	// Paradee v1.2's British voice, phonemized in en-gb. Parakeet-v3 is an American
	// model, so it hears a British accent as an accent: these numbers over-state the
	// errors more than they do for the American rows.
	["paradee_152ch_bf_isabella.wav", MID],
	["paradee_298ch_bf_isabella.wav", LONG],
];

console.log(`ASR=parakeet-v3 (nemo transducer, American English) — a British accent is scored by an American model, so the British rows over-state their errors.`);

for (const [f, ref] of CASES) {
	const file = path.join(HERE, f);
	if (!fs.existsSync(file)) { console.log(`${f}: missing`); continue; }
	const wav = readWav(file);
	const stream = rec.createStream();
	stream.acceptWaveform({ sampleRate: wav.sr, samples: wav.samples });
	rec.decode(stream);
	const text = rec.getResult(stream)?.text ?? "";
	const s = wer(ref, text);
	console.log(`\n${f} (${(wav.samples.length / wav.sr).toFixed(1)}s) WER ${s.werPct.toFixed(1)}% over ${s.refWords} words`);
	console.log(`  REF: ${ref}`);
	console.log(`  HYP: ${text}`);
	stream.free?.();
}
rec.free?.();
