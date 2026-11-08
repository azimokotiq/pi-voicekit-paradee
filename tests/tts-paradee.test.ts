import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	toMisaki,
	phonemesToIds,
	splitProsody,
	paradeeVoices,
	paradeeVoiceLang,
	resolveVoice,
} from "../extensions/voice/tts-paradee";
import { getTtsModel } from "../extensions/voice/tts-local-models";

/**
 * v1.2's own vocabulary, read out of the model's config.json (114 entries;
 * this snapshot covers what the tests feed it). The ids are the real ones, and
 * the test below re-checks them against an installed model, so this cannot
 * drift into a fixture that flatters the code.
 */
const VOCAB: Record<string, number> = {
	";": 1,
	":": 2,
	",": 3,
	".": 4,
	"!": 5,
	"?": 6,
	" ": 16,
	I: 25,
	A: 24,
	O: 31,
	Q: 33,
	a: 43,
	b: 44,
	t: 62,
	d: 46,
	e: 47,
	f: 48,
	h: 50,
	i: 51,
	j: 52,
	k: 53,
	m: 55,
	n: 56,
	p: 58,
	r: 60,
	s: 61,
	u: 63,
	v: 64,
	w: 65,
	z: 68,
	"ɐ": 70,
	"ɒ": 71,
	æ: 72,
	"ɛ": 86,
	"ɜ": 87,
	"ɪ": 102,
	"ɔ": 76,
	"ʊ": 135,
	"ʌ": 138,
	"ə": 83,
	"ɡ": 92,
	"ɑ": 69,
	"ɹ": 123,
	"θ": 119,
	ð: 81,
	"ː": 158,
	"ˈ": 156,
	"ˌ": 157,
};

function installedConfig(): any {
	for (const id of ["paradee-8m-v1_2", "paradee-8m-v1_0"]) {
		const f = join(homedir(), ".pi", "models", "tts", id, "config.json");
		if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
	}
	return null;
}

describe("Paradee G2P — toMisaki (vendored from upstream web/misaki.js)", () => {
	test("American: the v1.0 mapping is untouched", () => {
		expect(toMisaki("aɪ oʊ ɪɾ ɜːɹ ɚ ʔn̩")).toBe("I O ɪT ɜɹ əɹ tn");
		expect(toMisaki("bˈæθ fˈæst ˌoʊvɚ wˈɔːɾɚ")).toBe("bˈæθ fˈæst ˌOvəɹ wˈɔTəɹ");
	});

	test("British: əʊ→Q and eə→ɛː, and ðɪ (“the”) becomes ði", () => {
		expect(toMisaki("ɹˈeɪdɪŋ ˌəʊvə ðɪ ɑːt ɪɡˌnə ɒf eə", true)).toBe("ɹˈAdɪŋ ˌQvə ði ɑːt ɪɡˌnə ɒf ɛː");
	});

	test("British: eə is rewritten before the e→A rule can eat it", () => {
		// "eɪ" is American-only input; "eə" must not fall through to "A".
		expect(toMisaki("eɪ eə", true)).toBe("A ɛː");
		expect(toMisaki("eə", false)).toBe("Aə");
	});

	test("British keeps length marks, American drops them", () => {
		expect(toMisaki("bˈaθ ɡˈʊd ɫ ɪːvz", true)).toBe("bˈaθ ɡˈʊd l ɪːvz");
		expect(toMisaki("fˈast wˈɔːɾɚ").includes("ː")).toBe(false);
	});

	test("both accents feed the same vocabulary", () => {
		for (const british of [false, true]) {
			const mapped = phonemesToIds(toMisaki("ðə ˈkɒpɪɹaɪtɪz ˌəʊvə ðɪ ɑːt ɪɡˌnɒz", british), VOCAB);
			expect(mapped.dropped).toEqual([]);
			expect(mapped.ids[0]).toBe(0); // leading pad
			expect(mapped.ids[mapped.ids.length - 1]).toBe(0); // trailing pad
		}
	});

	test("dark-l becomes plain l, because the model has no id for ɫ", () => {
		// eSpeak British writes syllable-final /l/ dark; upstream's table leaves it
		// alone and the vocabulary has no ɫ, so its runtime loses the l of "milk",
		// "world" and "first".
		expect(toMisaki("mˈɪɫk wˈɜːɫd fˈɪɫst", true)).toBe("mˈɪlk wˈɜːld fˈɪlst");
		expect(toMisaki("mˈɪɫk").includes("ɫ")).toBe(false);
	});

	// The bench scripts run under plain node and cannot import TypeScript, so they
	// carry a JS copy of this table. Real phonemizer output, both accents.
	const CORPUS = [
		"bˈaθ ˌəʊvə ðə wˈɔːtə and ðə wˈɜːld",
		"bˈæθ ˌoʊvɚ ðə wˈɔːɾɚ ænd ðə wˈɜːld",
		"mˈɪɫk wˈɜːɫd fˈɪɫst",
		"ðə ɹˈeɪɾiˌoʊvɚ ˌəʊvə ðə ˈbˌaɪsɑːst ˈɑːf ˈeɪə",
		"nˈəʊʒən ˈbʌtə ˈʃuːm ɒf ˈeə nˈoʊʒən",
		"wˈɒt z ðə ˈhæpi.nəs ˌaɪ ˈsˌɛp(ə).rˈeɪtˌed.nəs",
		"jˈɛs ɐn ˈæp.əl ɫ ʔn̩ ˈəʊnli jə ˈbjuːtɪfᵊl",
		"kˈɒm.t͡ʃaɪl dˈʒˌʌst ɛksˈzækt liːt͡ʃʃ ˈɑːkt ɬ",
	];
	test("the bench copy of the table agrees with the shipped one", async () => {
		const bench = (await import("../paradee/bench/misaki.js")).toMisaki;
		for (const p of CORPUS) {
			expect(bench(p, false)).toBe(toMisaki(p, false));
			expect(bench(p, true)).toBe(toMisaki(p, true));
		}
	});

	test("phonemesToIds reports, never silently drops, a sound with no id", () => {
		const mapped = phonemesToIds("aʕb", VOCAB);
		expect(mapped.dropped).toEqual(["ʕ"]);
		expect(mapped.ids).toEqual([0, VOCAB["a"], VOCAB["b"], 0]);
	});

	test("the fixture ids are the model's ids (checked against an installed model)", () => {
		const config = installedConfig();
		if (!config) return; // model not installed here — the snapshot stands on its own
		const real = config.vocab as Record<string, number>;
		for (const [ch, id] of Object.entries(VOCAB)) expect(real[ch]).toBe(id);
		// Dark-l is what eSpeak British emits for syllable-final /l/, and the model
		// has no id for it — the mapping must fold it, not drop it silently.
		expect(real["ɫ"]).toBeUndefined();
		expect(phonemesToIds("mɫ", VOCAB).dropped).toEqual(["ɫ"]);
	});

	test("splitProsody keeps sentence punctuation as prosody ids", () => {
		expect(splitProsody("Hi there, right? Bye now.")).toEqual([
			{ segment: "Hi there", prosody: "," },
			{ segment: "right", prosody: "?" },
			{ segment: "Bye now", prosody: "." },
		]);
	});
});

const hasPhonemizer = await import("phonemizer")
	.then(() => true)
	.catch(() => false);

describe("Paradee G2P across accents (one process)", () => {
	// `phonemizer` applies its language argument to the first call of the process
	// only, so a British voice in a session that started American would get
	// American phonemes. The backend routes every accent the in-process wasm did
	// not claim through a per-accent child process; this is that round trip.
	test.skipIf(!hasPhonemizer)("one process speaks both accents", async () => {
		const { paradeeG2p } = await import("../extensions/voice/tts-paradee");
		const sentence = "Bath over the water and the world.";
		const us = (await paradeeG2p(sentence, "en-us")).join(" ");
		const gb = (await paradeeG2p(sentence, "en-gb")).join(" ");
		expect(us.includes("oʊ") || us.includes("ɚ")).toBe(true); // American diphthong / r-colour
		expect(gb.includes("əʊ") || gb.includes("ɒ")).toBe(true); // British ones
		expect(gb.includes("ɚ")).toBe(false); // and no r-colouring in the British one
		// A second request on the same worker must stay in its own accent.
		const gb2 = (await paradeeG2p("The nurse worked first, worth the world.", "en-gb")).join(" ");
		expect(gb2.includes("ɚ")).toBe(false);
	});
});

describe("Paradee voice selection (v1.2 `voice` input)", () => {
	// The sid IS the graph's `voice` input, so it must match config.json order.
	const CONFIG = { voices: ["af_heart", "bf_isabella", "am_puck", "bm_fable"] };

	test("the voices list is read from the model, in the model's order", () => {
		expect(paradeeVoices(CONFIG)).toEqual(["af_heart", "bf_isabella", "am_puck", "bm_fable"]);
		// v1.0/v1.1 configs list no voices at all; af_heart is baked into the graph.
		expect(paradeeVoices({})).toEqual(["af_heart"]);
		expect(paradeeVoices({ voices: [] })).toEqual(["af_heart"]);
	});

	test("the name prefix picks the misaki dictionary", () => {
		expect(paradeeVoiceLang("af_heart")).toBe("en-us");
		expect(paradeeVoiceLang("am_puck")).toBe("en-us");
		expect(paradeeVoiceLang("bf_isabella")).toBe("en-gb");
		expect(paradeeVoiceLang("bm_fable")).toBe("en-gb");
	});

	test("resolveVoice takes an index or a name, clamps and falls back", () => {
		expect(resolveVoice(CONFIG, 2)).toBe(2);
		expect(resolveVoice(CONFIG, "am_puck")).toBe(2);
		expect(resolveVoice(CONFIG, 99)).toBe(3); // clamped: a bad sid is an out-of-range table row
		expect(resolveVoice(CONFIG, -3)).toBe(0);
		expect(resolveVoice(CONFIG, "ghost")).toBe(0);
		expect(resolveVoice(CONFIG, undefined)).toBe(0);
	});

	test("the catalog entry lists the four voices in the model's order", () => {
		const model = getTtsModel("paradee-8m-v1_2");
		expect(model.backend).toBe("paradee");
		expect(model.voices.map((v) => v.sid)).toEqual([0, 1, 2, 3]);
		expect(model.voices.map((v) => v.name.split(" ")[0])).toEqual(["af_heart", "bf_isabella", "am_puck", "bm_fable"]);
		expect(model.voices.filter((v) => v.name.includes("British"))).toHaveLength(2);
		expect(paradeeVoices(CONFIG).map((v) => paradeeVoiceLang(String(v)))).toEqual(["en-us", "en-gb", "en-us", "en-gb"]);
	});
});
