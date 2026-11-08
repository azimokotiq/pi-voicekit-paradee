/**
 * Paradee-8M local TTS backend (https://github.com/sahilmahendrakar/paradee).
 *
 * Paradee is Kokoro distilled to ~8M parameters: one 8.5 MB int8 ONNX file
 * that runs ~18-25× faster than real time on a single CPU thread, at UTMOS
 * 4.40 (Kokoro-82M: 4.52) and a comparable word error rate. On this machine
 * (measured 2026-10-17, Windows/x64, 1 CPU thread) it synthesizes at RTF 0.12
 * — a 298-character reply in 2.2 s, where Kokoro-int8 through sherpa-onnx
 * needs ~34 s for the same text.
 *
 * v1.2 speaks FOUR of Kokoro's voices out of that one file: `af_heart` and
 * `am_puck` (American) and `bf_isabella` and `bm_fable` (British), in the
 * `voices` order of the model's `config.json`. Each half of the graph carries
 * a small table with one learned vector per voice, so the model file is
 * identical in size and speed to v1.1 and only the chosen row changes.
 *
 * WHY A SEPARATE BACKEND (it cannot use the sherpa-onnx `kokoro` slot):
 * sherpa's Kokoro slot takes TEXT, phonemizes internally with espeak-ng-data,
 * and mixes in a `voices.bin` speaker embedding. Paradee's graph is different:
 * inputs `input_ids` (int64 [1,T], misaki phoneme ids, `0` pad at each end,
 * max 512 positions), `speed` (float32 [1]) and — new in v1.2 — `voice`
 * (int64 [1], the voice's index in `config.json`'s `voices` list); output
 * `waveform` (float32 [1, samples]) at 24 kHz. So this module runs
 * onnxruntime-node directly instead of OfflineTts. v1.0/v1.1 graphs have no
 * `voice` input at all and baked `af_heart` in, which is why the feed is built
 * from `session.inputNames` rather than assumed.
 *
 * G2P: Paradee was trained on misaki (Kokoro's own G2P) phonemes, American
 * dictionary for the `af_`/`am_` voices and British for the `bf_`/`bm_` ones.
 * Feeding it raw eSpeak NG phonemes mumbles it (Paradee's own docs report
 * Whisper WER 31% vs 3%). We phonemize with the `phonemizer` npm package
 * (eSpeak NG compiled to wasm — the same one kokoro-js uses), ask it for
 * `en-us` or `en-gb` depending on the voice, and pass the result through
 * `toMisaki`, vendored from the upstream `web/misaki.js` (Apache-2.0), which
 * is misaki's own eSpeak→misaki mapping table for both accents. eSpeak's
 * British is not identical to misaki's — it says the vowel in "bath" and
 * "fast" differently — so the British voices are a shade less faithful than
 * the American ones; upstream reports the same and ships the same table.
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

/**
 * Convert eSpeak NG IPA output to the misaki spelling Paradee was trained on.
 *
 * `british` selects misaki's British table (its lang 'b', which the `bf_` and
 * `bm_` voices were trained on): eSpeak's "eə" is misaki's ɛː — and must be
 * rewritten before the `e` → `A` rule eats it — British vowels KEEP their
 * length marks, "the" before a vowel is ði, and `əʊ` is misaki's `Q`.
 */
export function toMisaki(ps: string, british = false): string {
	if (british) ps = ps.split("eə").join("ɛː");
	for (const [a, b] of E2M) ps = ps.split(a).join(b);
	ps = ps.replace(/(\S)̩/gu, "ᵊ$1").replace(/̩/g, "");
	// misaki writes a syllabic l at the end of a word as ᵊl (naval -> nˈAvᵊl).
	ps = ps.replace(/əl(?=[\s;:,.!?—…"“”()]|$)/gu, "ᵊl");
	// misaki's table maps ɐ to ə, but its lexicon keeps ɐ for the article "a"
	// (and in British, for "an" too).
	ps = british
		? ps.replace(/ɐ(?!n?(?:[\s;:,.!?—…"“”()]|$))/gu, "ə")
		: ps.replace(/ɐ(?![\s;:,.!?—…"“”()]|$)/gu, "ə");
	if (british) {
		ps = ps.split("iə").join("ɪə").split("əʊ").join("Q");
		ps = ps.replace(/(^|\s)ðɪ(?=\s|$)/gu, "$1ði"); // "the" before a vowel
	} else {
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
	}
	// Deviation from upstream's table (which leaves dark-l alone): eSpeak writes
	// syllable-final /l/ as ɫ — mostly in British output — and Paradee's vocabulary
	// has no id for it, so upstream's runtime silently loses the l of "milk" and
	// "world". The model does have plain `l`, so fold it.
	ps = ps.split("ɫ").join("l");
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

export interface ParadeeConfig {
	sample_rate: number;
	n_token: number;
	vocab: Record<string, number>;
	/** v1.2 only: model order, e.g. ["af_heart","bf_isabella","am_puck","bm_fable"]. */
	voices?: string[];
	version?: string;
}

/** Voice names in the model's own order; v1.0/v1.1 graphs baked af_heart in. */
export function paradeeVoices(config: ParadeeConfig): string[] {
	return Array.isArray(config.voices) && config.voices.length ? config.voices : ["af_heart"];
}

/**
 * The eSpeak-ng tag whose phonemes match a voice: misaki learned the `bf_` and
 * `bm_` voices with its British dictionary, so those want `en-gb`.
 */
export function paradeeVoiceLang(voice: string): string {
	return /^b[fm]_/.test(voice) ? "en-gb" : "en-us";
}

interface ParadeeEngine {
	session: any;
	config: ParadeeConfig;
	phonemize: (text: string, language?: string) => Promise<string[]>;
	/** Characters the vocab has no id for, observed while phonemizing (diagnostics). */
	missing: Set<string>;
	modelFile: string;
	threads: number;
	/** True when this graph takes the v1.2 `voice` input. */
	hasVoiceInput: boolean;
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

/**
 * Phonemize in the accent `accent` demands, working around a `phonemizer`
 * limitation: eSpeak NG's wasm voice is PROCESS-GLOBAL and the package applies
 * the `language` argument to the first call only — every later call keeps
 * speaking the first accent, whatever you ask for (verified 2026-11-08 on
 * phonemizer@1.2.1 under node 24 and bun 1.4; a fresh process per accent is
 * correct every time).
 *
 * Paradee v1.2 needs both accents alive in one pi session — `af_`/`am_` voices
 * take misaki American, `bf_`/`bm_` take misaki British, and the wrong G2P is
 * the difference between WER 3% and 31% upstream. So the accent the
 * in-process wasm latched onto goes through `phonemizer` directly (free), and
 * every other accent goes through a small child process that was started with
 * that accent (`paradee-g2p-worker.mjs`), one per accent, kept alive, killed on
 * release. Cold cost is the ~0.4 s wasm load, paid once per accent per session;
 * after that it is a couple of milliseconds per utterance.
 */
let inprocAccent: string | null = null;

interface G2pWorker {
	child: any;
	seq: number;
	pending: Map<number, { resolve: (v: string[]) => void; reject: (e: unknown) => void }>;
	dead: boolean;
}

const g2pWorkers = new Map<string, G2pWorker>();

function killG2pWorkers(): void {
	for (const [accent, w] of g2pWorkers) {
		w.dead = true;
		for (const { reject } of w.pending.values()) reject(new Error(`G2P worker for ${accent} was closed`));
		w.pending.clear();
		try {
			w.child.kill();
		} catch {}
	}
	g2pWorkers.clear();
}

function getG2pWorker(accent: string): G2pWorker {
	const existing = g2pWorkers.get(accent);
	if (existing && !existing.dead) return existing;
	const { spawn } = loadDep("node:child_process") as typeof import("node:child_process");
	const { createInterface } = loadDep("node:readline") as typeof import("node:readline");
	const script = path.join(path.dirname(typeof __filename === "undefined" ? process.cwd() : __filename), "paradee-g2p-worker.mjs");
	if (!fs.existsSync(script)) throw new Error(`Paradee G2P worker is missing (${script})`);
	const child = spawn(process.execPath, [script, accent], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
	// A worker must never be the reason pi cannot exit: unref its handles, so an
	// idle G2P worker is invisible to the event loop, and pi's exit closes the
	// stdin pipe, which ends the worker on its own.
	const unrefable = [child, child.stdin, child.stdout] as { unref?: () => void }[];
	for (const h of unrefable) {
		try {
			h?.unref?.();
		} catch {}
	}
	const w: G2pWorker = { child, seq: 0, pending: new Map(), dead: false };
	const die = (why: string) => {
		w.dead = true;
		for (const { reject } of w.pending.values()) reject(new Error(`Paradee ${accent} G2P worker ${why}`));
		w.pending.clear();
		if (g2pWorkers.get(accent) === w) g2pWorkers.delete(accent);
	};
	child.on("error", (e: unknown) => die(`failed to start (${String((e as Error)?.message ?? e)})`));
	child.on("exit", () => die("exited"));
	createInterface({ input: child.stdout, terminal: false }).on("line", (line: string) => {
		let msg: { id?: number; phonemes?: string[]; error?: string };
		try {
			msg = JSON.parse(line);
		} catch {
			return; // worker banner / non-JSON noise
		}
		const p = w.pending.get(msg.id ?? -1);
		if (!p) return;
		w.pending.delete(msg.id!);
		if (msg.error) p.reject(new Error(`Paradee ${accent} G2P: ${msg.error}`));
		else p.resolve(msg.phonemes ?? []);
	});
	g2pWorkers.set(accent, w);
	return w;
}

async function phonemizeAccent(engine: ParadeeEngine, text: string, accent: string): Promise<string[]> {
	if (inprocAccent === null || inprocAccent === accent) {
		try {
			const out = await engine.phonemize(text, accent);
			inprocAccent = accent; // from here the in-process wasm is this accent, permanently
			return Array.isArray(out) ? out : [String(out)];
		} catch (err) {
			if (inprocAccent === accent) throw err; // a real failure of the accent we already use
			// phonemizer is missing entirely, so the worker cannot run either.
			throw new Error(
				`Paradee needs the \`phonemizer\` package to speak ${accent} (${String((err as Error)?.message ?? err)}). ` +
					`Install it with \`npm i phonemizer\` next to pi-voicekit, or pick a voice of the accent that works.`
			);
		}
	}
	const worker = getG2pWorker(accent);
	const id = ++worker.seq;
	const payload = JSON.stringify({ id, text });
	await new Promise<void>((resolve, reject) => {
		worker.child.stdin.write(`${payload}\n`, (err: unknown) => (err ? reject(err) : resolve()));
	});
	return await new Promise<string[]>((resolve, reject) => {
		const timer = setTimeout(() => {
			worker.pending.delete(id);
			reject(new Error(`Paradee ${accent} G2P worker timed out`));
		}, 25_000);
		worker.pending.set(id, {
			resolve: (v) => (clearTimeout(timer), resolve(v)),
			reject: (e) => (clearTimeout(timer), reject(e)),
		});
	});
}

/**
 * Test/diagnostic seam: phonemize `text` in `accent` through exactly the
 * dispatch `synthesizeParadee` uses (in-process wasm for the accent that won the
 * process, a child worker for the others), without loading an ONNX session.
 */
export async function paradeeG2p(text: string, accent: string): Promise<string[]> {
	const ph = loadDep("phonemizer");
	const fn = (ph.phonemize ?? ph.default?.phonemize ?? ph) as (t: string, l?: string) => Promise<string[]>;
	if (typeof fn !== "function") throw new Error("phonemizer exports no phonemize()");
	return phonemizeAccent({ phonemize: fn } as unknown as ParadeeEngine, text, accent);
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
	return {
		session,
		config,
		phonemize,
		missing: new Set(),
		modelFile,
		threads: nThreads,
		hasVoiceInput: (session.inputNames || []).includes("voice"),
	};
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
			const e = p ? await p : undefined;
			await e?.session?.release?.();
		} catch {}
	}
	killG2pWorkers();
}

export interface ParadeeSynthOpts {
	modelDir: string;
	text: string;
	/** 1.0 = normal speed; callers clamp to 0.5–2.0 upstream. */
	speed?: number;
	/**
	 * Voice to speak: an index into the model's `voices` list, or a voice name.
	 * Out-of-range indices clamp, an unknown name falls back to voices[0].
	 */
	voice?: number | string;
	/**
	 * eSpeak-ng tag for G2P, overriding the one derived from the voice. Leave it
	 * unset: the British voices need `en-gb` and the American ones `en-us`, and
	 * only the voice says which.
	 */
	language?: string;
	signal?: AbortSignal;
	threads?: number;
}

/** Resolve a voice choice to an index into the model's own `voices` list. */
export function resolveVoice(config: ParadeeConfig, voice?: number | string): number {
	const list = paradeeVoices(config);
	if (typeof voice === "string") {
		const at = list.indexOf(voice);
		return at >= 0 ? at : 0;
	}
	if (typeof voice === "number" && Number.isFinite(voice)) {
		return Math.max(0, Math.min(list.length - 1, Math.floor(voice)));
	}
	return 0;
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
	const { modelDir, text, speed = 1.0, signal } = opts;
	const engine = await loadParadee(modelDir, opts.threads);
	const { vocab } = engine.config;
	const voiceIndex = resolveVoice(engine.config, opts.voice);
	const voiceName = paradeeVoices(engine.config)[voiceIndex];
	const british = paradeeVoiceLang(voiceName) === "en-gb";
	const language = opts.language || paradeeVoiceLang(voiceName);
	const aborted = () => signal?.aborted === true;
	if (aborted()) throw abortError();

	const chunks: Float32Array[] = [];
	for (const { segment, prosody } of splitProsody(text)) {
		if (aborted()) throw abortError();
		let phonemes: string;
		try {
			const parts = await phonemizeAccent(engine, segment, language);
			phonemes = toMisaki(Array.isArray(parts) ? parts.join(" ") : String(parts), british);
		} catch {
			continue; // G2P hiccup on one segment must not kill the whole reply
		}
		for (;;) {
			const { head, rest } = cutPhonemes(phonemes);
			if (!head) break;
			const { ids, dropped } = phonemesToIds(head + (prosody && !rest ? prosody : ""), vocab);
			for (const c of dropped) engine.missing.add(c);
			chunks.push(await runWindow(engine, ids, speed, voiceIndex));
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

async function runWindow(engine: ParadeeEngine, ids: number[], speed: number, voiceIndex = 0): Promise<Float32Array> {
	const ort = loadDep("onnxruntime-node");
	const feeds: Record<string, any> = {
		input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]),
		speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
	};
	// v1.2 picks its voice from a learned table with this input. v1.0/v1.1 graphs
	// never declared it, and onnxruntime rejects an input the graph does not name,
	// so the feed is built from what this session actually asks for.
	if (engine.hasVoiceInput) {
		feeds.voice = new ort.Tensor("int64", BigInt64Array.from([BigInt(voiceIndex)]), [1]);
	}
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
