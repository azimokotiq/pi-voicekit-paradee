// kokoro-js phonemizes with eSpeak NG, but Paradee only ever saw phonemes from
// misaki (Kokoro's own G2P) in training. The two spell the same sounds differently
// ("aɪ" vs "I", "oʊ" vs "O", length marks, flaps), and fed raw eSpeak phonemes
// Paradee mumbles (Whisper word error rate 31% vs 3%). This is misaki's own
// eSpeak-to-misaki table (misaki/espeak.py, EspeakFallback), adapted to eSpeak
// output that has no tie marks between the two halves of a diphthong — American
// English, and since Paradee v1.2 British English too (bf_isabella / bm_fable are
// trained on misaki's British dictionary, so the phonemizer has to speak British).
//
// This is a JavaScript copy of the table shipped in
// extensions/voice/tts-paradee.ts, kept for the bench scripts, which run under
// plain node and cannot import TypeScript. tests/tts-paradee.test.ts asserts the
// two agree over a corpus, so this file cannot drift.
const E2M = [
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

export function toMisaki(ps, british = false) {
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
  ps = ps.split("o").join("ɔ");
  // Deviation from upstream's table (which leaves dark-l alone): eSpeak writes
  // syllable-final /l/ as ɫ — mostly in British output — and Paradee's vocabulary
  // has no id for it, so upstream's runtime silently loses the l of "milk" and
  // "world". The model does have plain `l`, so fold it.
  ps = ps.split("ɫ").join("l");
  return ps.split("ɾ").join("T").split("ʔ").join("t");
}
