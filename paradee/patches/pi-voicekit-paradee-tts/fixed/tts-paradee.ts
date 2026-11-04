/**
 * Paradee-8M local TTS backend (https://github.com/sahilmahendrakar/paradee).
 *
 * Paradee is Kokoro's `af_heart` voice distilled into 8.07M parameters: one
 * 9 MB int8 ONNX file that runs ~18-25× faster than real time on a single CPU
 * thread, at UTMOS 4.41 (Kokoro-82M: 4.52) and the same word error rate. On
 * this machine (measured 2026-10-17, Windows/x64, 1 CPU thread) it synthesizes
 * at RTF 0.12 — a 298-character reply in 2.2 s, where Kokoro-int8 through
 * sherpa-onnx needs ~34 s for the same text.
 *
 * WHY A SEPARATE BACKEND (it cannot use the sherpa-onnx `kokoro` slot):
 * sherpa's Kokoro slot takes TEXT, phonemizes internally with espeak-ng-data,
 * and mixes in a `voices.bin` speaker embedding. Paradee's graph is different:
 * inputs `input_ids` (int64 [1,T], misaki phoneme ids, `0` pad at each end,
 * max 512 positions) and `speed` (float32 [1]); output `waveform`
 * (float32 [1, samples]) at 24 kHz. One voice is baked in, so there is no
 * speaker id. So this module runs onnxruntime-node directly instead of
 * OfflineTts.
 *
 * G2P: Paradee was trained on misaki (Kokoro's own G2P) phonemes. Feeding it
 * raw eSpeak NG phonemes mumbles it (Paradee's own docs report Whisper WER
 * 31% vs 3%). We phonemize with the `phonemizer` npm package (eSpeak NG
 * compiled to wasm — the same one kokoro-js uses) and pass the result through
 * `toMisaki`, vendored from the upstream `web/misaki.js` (Apache-2.0), which
 * is misaki's own eSpeak→misaki mapping table.
 *
 * Dependencies (`onnxruntime-node`, `phonemizer`) are loaded lazily so a
 * missing install degrades to a clear error message instead of breaking the
 * whole voice extension at import time.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

/** Text side has 512 positions; two are the `0` pads at each end. */
const MAX_PHONEMES = 510;

/** Sentence delimiters Paradee's vocabulary carries ids for (prosody breaks). */
const PROSODY = ";:,.!?—…()“”\"";

/**
 * eSpeak NG → misaki phoneme mapping, vendored from
 * https://github.com/sahilmahendrakar/paradee/blob/main/web/misaki.js
 * (Apache-2.0). Without it Paradee mumbles: the two G2P systems spell the same
 * sounds differently ("aɪ" vs "I", "oʊ" vs "O", length marks, flaps).
 */
const E2M: ReadonlyArray<readonly [string, string]> = [
	["ʔˌn̩", "ʔn"],
	["ʔn̩", "ʔn"],
	["aɪ", "I"],
	["aʊ", "W"],
	["dʒ", "ʤ"],
	["eɪ", "A"],
	["e", "A"],
	["tʃ", "ʧ"],
	["ɔɪ", "Y"],
	["ʲo", "jo"],
	["ʲə", "jə"],
	["ʲ", ""],
	["ɚ", "əɹ"],
	["r", "ɹ"],
	["x", "k"],
	["ç", "k"],
	["ɬ", "l"],
	["̃", ""],
];

/** Convert eSpeak NG IPA output to the misaki spelling Paradee was trained on. */
export function toMisaki(ps: string): string {
	for (const [a, b] of E2M) ps = ps.split(a).join(b);
	ps = ps.replace(/(\S)̩/gu, "ᵊ$1").replace(/̩/g, "");
	// misaki writes a syllabic l at the end of a word as ᵊl (naval -> nˈAvᵊl).
	ps = ps.replace(/əl(?=[\s;:,.!?—…"“”()]|$)/gu, "ᵊl");
	// misaki's table maps ɐ to ə, but its lexicon keeps ɐ for the article "a".
	ps = ps.replace(/ɐ(?![\s;:,.!?—…"“”()]|$)/gu, "ə");
	ps = ps
		.split("oʊ")
		.join("O")
		.split("ɜːɹ")
		.join("ɜɹ")
		.split("ɜː")
		.join("ɜɹ")
		.split("ɪə")
		.join("iə")
		.split("ː")
		.join("");
	ps = ps.split("o").join("ɔ");
	return ps.split("ɾ").join("T").split("ʔ").join("t");
}

/** Map misaki phonemes to vocabulary ids, dropping anything out-of-vocab. */
export function phonemesToIds(
	phonemes: string,
	vocab: Record<string, number>
): { ids: number[]; dropped: string[] } {
	const ids: number[] = [];
	const dropped: string[] = [];
	for (const c of phonemes) {
		const id = vocab[c];
		if (id === undefined) {
			if (!dropped.includes(c)) dropped.push(c);
			continue;
		}
		ids.push(id);
		if (ids.length >= MAX_PHONEMES) break;
	}
	return { ids: [0, ...ids, 0], dropped }; // `0` pad at each end
}

/**
 * Split text into (segment, following-punctuation) pairs. eSpeak-based
 * phonemizers drop punctuation, but Paradee's vocabulary has ids for it and
 * they carry the prosody (pauses, question intonation), so we keep the
 * punctuation aside and re-insert it between phonemized segments.
 */
export function splitProsody(text: string): Array<{ segment: string; prosody: string }> {
	const out: Array<{ segment: string; prosody: string }> = [];
	for (const raw of text.split(/\n+/)) {
		const line = raw.trim();
		if (!line) continue;
		// Keep the delimiters so nothing is lost: split("x,") → ["x", ",", ""].
		const pieces = line.split(new RegExp(`([${PROSODY.replace(/[\\^\]]/g, "\\$&")}])`, "u"));
		let segment = "";
		for (let i = 0; i < pieces.length; i++) {
			const p = pieces[i]!;
			if (p.length === 1 && PROSODY.includes(p)) {
				if (segment.trim()) out.push({ segment: segment.trim(), prosody: p });
				else if (out.length) out[out.length - 1]!.prosody += p;
				segment = "";
			} else {
				segment += p;
			}
		}
		if (segment.trim()) out.push({ segment: segment.trim(), prosody: "" });
	}
	return out;
}

/** Cut a phoneme string at the last space that fits the 510-position window. */
function cutPhonemes(phonemes: string): { head: string; rest: string } {
	if (phonemes.length <= MAX_PHONEMES) return { head: phonemes, rest: "" };
	let cut = phonemes.lastIndexOf(" ", MAX_PHONEMES);
	if (cut <= 0) cut = MAX_PHONEMES;
	return { head: phonemes.slice(0, cut), rest: phonemes.slice(cut).trimStart() };
}

interface ParadeeConfig {
	sample_rate: number;
	n_token: number;
	vocab: Record<string, number>;
}

interface ParadeeEngine {
	session: any;
	config: ParadeeConfig;
	phonemize: (text: string, language?: string) => Promise<string[]>;
	/** Characters the vocab has no id for, observed while phonemizing (diagnostics). */
	missing: Set<string>;
	modelFile: string;
	threads: number;
}

let loadError: string | null = null;
const engines = new Map<string, Promise<ParadeeEngine>>();

function loadDep(name: string): any {
	// Resolve from THIS module's directory: pi-voicekit lives in
	// ~/.pi/agent/npm/node_modules/pi-voicekit, so deps resolve from the
	// harness node_modules the same way sherpa-onnx-node does.
	const base = typeof __filename === "undefined" ? path.join(process.cwd(), "noop.cjs") : __filename;
	const req = createRequire(base);
	return req(name);
}

/**
 * onnxruntime-node must be dlopened BEFORE sherpa-onnx-node.
 *
 * Both packages bundle their own copy of ONNX Runtime. Once one of them is
 * resident in the process, the Windows loader refuses the other's native
 * binding outright: require("onnxruntime-node") then fails with
 * "The operating system cannot run %1. …onnxruntime_binding.node". Load order is
 * the only variable — ORT-first then sherpa is fine, ORT-after-sherpa is fatal
 * (verified both ways in patches/pi-voicekit-paradee-tts/test_load_order.mjs).
 *
 * The guarantee that matters at runtime lives in `loadSherpa()` (see
 * README, "Load-order constraint"): voice.ts loads every ./voice/* module with
 * `await import()`, so nothing here runs before the STT path reaches sherpa and
 * an entry-level prime cannot win that race. This module-level prime is the
 * fallback for processes that reach TTS first (or never call loadSherpa at all);
 * it costs ~30 ms and keeps the invariant regardless of which path is taken.
 */
let ortPrimed = false;
function primeOnnxRuntime(): void {
	if (ortPrimed) return;
	ortPrimed = true;
	try {
		loadDep("onnxruntime-node");
	} catch (err) {
		// Either genuinely absent, or sherpa already won the race. Record it so
		// synthesize() reports the real reason instead of "not installed".
		loadError = (err as Error).message;
	}
}
primeOnnxRuntime();

/** True when the native ONNX Runtime binding is resident in this process. */
export function isParadeeRuntimeReady(): boolean {
	try {
		return !!loadDep("onnxruntime-node");
	} catch {
		return false;
	}
}

/** Lazy-load (and cache) the ONNX session + phonemizer for one model dir. */
export async function loadParadee(modelDir: string, threads?: number): Promise<ParadeeEngine> {
	const cached = engines.get(modelDir);
	if (cached) return cached;
	const pending = createEngine(modelDir, threads);
	engines.set(modelDir, pending);
	try {
		return await pending;
	} catch (err) {
		engines.delete(modelDir); // allow a retry after a transient failure
		throw err;
	}
}

async function createEngine(modelDir: string, threads?: number): Promise<ParadeeEngine> {
	const configPath = path.join(modelDir, "config.json");
	const modelFile = [path.join(modelDir, "paradee_int8.onnx"), path.join(modelDir, "paradee.onnx")].find((f) =>
		fs.existsSync(f)
	);
	if (!fs.existsSync(configPath) || !modelFile) {
		throw new Error(
			`Paradee model files are missing under ${modelDir} (expected config.json and paradee_int8.onnx). ` +
				`Install it with /voice-settings → Speak → Models, or download it manually.`
		);
	}
	let ort: any;
	let phonemize: (text: string, language?: string) => Promise<string[]>;
	try {
		ort = loadDep("onnxruntime-node");
		const ph = loadDep("phonemizer");
		phonemize = (ph.phonemize ?? ph.default?.phonemize ?? ph) as typeof phonemize;
		if (typeof phonemize !== "function") throw new Error("phonemizer exports no phonemize()");
	} catch (err) {
		loadError = (err as Error).message;
		// A refused native image is not a missing package: it means sherpa's copy
		// of ONNX Runtime got resident first. See primeOnnxRuntime().
		if (/cannot run|not a valid Win32|invalid image/i.test(loadError)) {
			throw new Error(
				"Paradee could not load its ONNX Runtime binding because sherpa-onnx-node already has a " +
					"different copy resident in this process (" +
					loadError +
					"). This happens when something dlopens sherpa-onnx-node without going through " +
					"loadSherpa(), which is the one place that primes onnxruntime-node first. " +
					"Restart pi; if it persists, check that extensions/voice/sherpa-loader.ts still " +
					"carries the prime (patches/pi-voicekit-paradee-tts/apply.sh)."
			);
		}
		throw new Error(
			`Paradee needs the \`onnxruntime-node\` and \`phonemizer\` packages, which are not installed ` +
				`(${loadError}). Reinstall pi-voicekit, or run \`npm i onnxruntime-node phonemizer\` in the ` +
				`pi extensions directory (~/.pi/agent/npm).`
		);
	}
	const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as ParadeeConfig;
	const nThreads = threads && threads > 0 ? threads : Math.min(4, os.availableParallelism?.() ?? os.cpus().length ?? 2);
	const session = await ort.InferenceSession.create(modelFile, {
		intraOpNumThreads: nThreads,
		interOpNumThreads: 1,
		logSeverityLevel: 3, // ort: 3 = error only — keeps the C++ warnings out of the TUI
	});
	return { session, config, phonemize, missing: new Set(), modelFile, threads: nThreads };
}

/** Pre-warm the session (model load + graph optimisation) off the critical path. */
export async function preloadParadee(modelDir: string, threads?: number): Promise<boolean> {
	try {
		await loadParadee(modelDir, threads);
		return true;
	} catch {
		return false;
	}
}

export function getParadeeError(): string | null {
	return loadError;
}

/** Free ONNX sessions (called on model switch / shutdown to release RAM). */
export async function releaseParadee(modelDir?: string): Promise<void> {
	const keys = modelDir ? [modelDir] : [...engines.keys()];
	for (const k of keys) {
		const p = engines.get(k);
		engines.delete(k);
		try {
			const e = await p;
			await e.session?.release?.();
		} catch {}
	}
}

export interface ParadeeSynthOpts {
	modelDir: string;
	text: string;
	/** 1.0 = normal speed; callers clamp to 0.5–2.0 upstream. */
	speed?: number;
	/** eSpeak-ng voice tag for G2P; Paradee is American English only. */
	language?: string;
	signal?: AbortSignal;
	threads?: number;
}

/**
 * Synthesize text to mono float PCM at the model's sample rate (24 kHz).
 *
 * Sentences are synthesized one window at a time (the text side only has 512
 * positions) and concatenated, mirroring the reference Python runtime. Aborts
 * take effect between windows — at worst one sentence of latency, which at
 * RTF ~0.1 is a fraction of a second.
 */
export async function synthesizeParadee(opts: ParadeeSynthOpts): Promise<{ samples: Float32Array; sampleRate: number }> {
	const { modelDir, text, speed = 1.0, language = "en-us", signal } = opts;
	const engine = await loadParadee(modelDir, opts.threads);
	const { vocab } = engine.config;
	const aborted = () => signal?.aborted === true;
	if (aborted()) throw abortError();

	const chunks: Float32Array[] = [];
	for (const { segment, prosody } of splitProsody(text)) {
		if (aborted()) throw abortError();
		let phonemes: string;
		try {
			const parts = await engine.phonemize(segment, language);
			phonemes = toMisaki(Array.isArray(parts) ? parts.join(" ") : String(parts));
		} catch {
			continue; // G2P hiccup on one segment must not kill the whole reply
		}
		for (;;) {
			const { head, rest } = cutPhonemes(phonemes);
			if (!head) break;
			const { ids, dropped } = phonemesToIds(head + (prosody && !rest ? prosody : ""), vocab);
			for (const c of dropped) engine.missing.add(c);
			chunks.push(await runWindow(engine, ids, speed));
			if (!rest) break;
			phonemes = rest;
		}
	}

	const total = chunks.reduce((n, c) => n + c.length, 0);
	if (!total) {
		throw new Error(
			`Paradee produced no audio for this text (${text.slice(0, 60)}…). ` +
				(engine.missing.size
					? `No vocabulary ids for: ${[...engine.missing].slice(0, 12).join(" ")}.`
					: "The grapheme-to-phoneme step returned nothing.")
		);
	}
	const out = new Float32Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return { samples: out, sampleRate: engine.config.sample_rate || 24000 };
}

async function runWindow(engine: ParadeeEngine, ids: number[], speed: number): Promise<Float32Array> {
	const ort = loadDep("onnxruntime-node");
	const feeds: Record<string, any> = {
		input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]),
		speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
	};
	const outputs = await engine.session.run(feeds);
	const name = engine.session.outputNames?.[0] ?? "waveform";
	const raw = outputs[name]?.data ?? outputs[Object.keys(outputs)[0]!]?.data;
	if (!raw) throw new Error(`Paradee ONNX run returned no "${name}" output.`);
	const wave = Float32Array.from(raw as ArrayLike<number>);
	for (let i = 0; i < wave.length; i++) {
		if (!Number.isFinite(wave[i]!)) wave[i] = 0; // a NaN sample would poison the whole buffer
	}
	return wave;
}

function abortError(): Error {
	if (typeof DOMException === "function") return new DOMException("Paradee synthesis aborted", "AbortError");
	const e = new Error("Paradee synthesis aborted");
	(e as any).name = "AbortError";
	return e;
}
