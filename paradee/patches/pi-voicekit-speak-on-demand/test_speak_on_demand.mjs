// Self-test for the speak-on-demand patch (pi-voicekit-speak-on-demand).
//
// Proves three things about the INSTALLED pi-voicekit:
//   1. wiring — voice.ts registers the two new shortcuts and the two new
//      commands, and reads the new config fields through the same startup
//      path as the recording toggle.
//   2. cap logic is in BOTH auto-speak paths (streaming message_end flush and
//      the legacy turn_end fallback), so a long reply cannot be narrated by
//      the path the cap forgot.
//   3. behaviour — the config plumbing actually parses/validates the new
//      fields (global honoured, invalid shortcut rejected, project block
//      cannot rebind keys), and the length probe the cap relies on behaves as
//      claimed against the real prepareForSpeech().
//
// Run: node ~/.pi/agent/patches/pi-voicekit-speak-on-demand/test_speak_on_demand.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Module from "node:module";
import assert from "node:assert";

const NPM = path.join(os.homedir(), ".pi", "agent", "npm");
const PKG = path.join(NPM, "node_modules", "pi-voicekit");
const VOICE_TS = path.join(PKG, "extensions", "voice.ts");
const CONFIG_TS = path.join(PKG, "extensions", "voice", "config.ts");
const FILTER_TS = path.join(PKG, "extensions", "voice", "tts-text-filter.ts");

// Same NODE_PATH bootstrap as the other patch self-tests.
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

// ─── 1. wiring (static, against the installed voice.ts) ──────────────────────
const src = fs.readFileSync(VOICE_TS, "utf8");
for (const [label, re] of [
	["speak shortcut registration", /pi\.registerShortcut\(resolvedSpeakShortcut as KeyId/],
	["auto-speak shortcut registration", /pi\.registerShortcut\(resolvedAutoSpeakShortcut as KeyId/],
	["/voice-read", /pi\.registerCommand\("voice-read"/],
	["/voice-autospeak", /pi\.registerCommand\("voice-autospeak"/],
	["last-reply reader", /function lastAssistantReplyText\(/],
	["stop-or-read action", /async function speakLastReplyOrStop\(/],
	["mute/unmute action", /function setAutoSpeak\(/],
	["startup shortcut resolution", /loadGlobalVoiceShortcut\(\s*"speakShortcut"/],
	["startup auto-speak shortcut resolution", /loadGlobalVoiceShortcut\(\s*"autoSpeakShortcut"/],
]) {
	assert.ok(re.test(src), `voice.ts must contain the ${label}`);
}
assert.equal((src.match(/function lastAssistantReplyText\(/g) ?? []).length, 1, "exactly one last-reply reader");
assert.equal((src.match(/function autoSpeakMaxChars\(/g) ?? []).length, 1, "exactly one cap accessor");

// ─── 2. the cap gates BOTH auto-speak paths ─────────────────────────────────
assert.ok(
	/const cap = autoSpeakMaxChars\(\);\n\t\tif \(cap > 0 && !isFinal\) return;/.test(src),
	"the streaming path must buffer (not narrate sentence-by-sentence) while a cap is set"
);
const capPrepare = src.match(/maxChars: cap > 0 \? cap : 2000/g) ?? [];
assert.equal(capPrepare.length, 2, "both auto-speak paths must size prepareForSpeech by the cap");
assert.ok(/autoSpeak\.skipped-long/.test(src), "streaming path must log the deliberate silence");
assert.ok(/turn_end skipped-long/.test(src), "turn_end fallback must honour the cap too");
// A reply skipped for length is marked handled, so the OTHER path cannot re-offer it.
assert.equal(
	(src.match(/markReplySpoken\((?:messageId|id)\);/g) ?? []).length >= 3,
	true,
	"skipped-long branches must mark the reply handled (>= 3 call sites incl. upstream's)"
);
// Master gates unchanged: narration still short-circuits on ttsEnabled/ttsAutoSpeak.
assert.equal(
	(src.match(/if \(!config\.ttsEnabled \|\| !config\.ttsAutoSpeak\) return;/g) ?? []).length,
	2,
	"both auto-speak paths must still short-circuit on the master flags"
);

// ─── 3a. config plumbing ────────────────────────────────────────────────────
const cfg = jiti(CONFIG_TS);
assert.equal(cfg.DEFAULT_CONFIG.ttsAutoSpeakMaxChars, 0, "upstream default behaviour: no cap");
assert.equal(cfg.DEFAULT_CONFIG.speakShortcut, "alt+s", "default read-on-demand key");
assert.equal(cfg.DEFAULT_CONFIG.autoSpeakShortcut, "alt+a", "default mute/unmute key");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voicekit-speak-"));
const agentDir = path.join(tmp, "agent");
const cwd = path.join(tmp, "proj");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });

function writeAgent(voice) {
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ voice }));
}

writeAgent({ ttsEnabled: true, ttsAutoSpeak: true, ttsAutoSpeakMaxChars: 400, speakShortcut: "ctrl+j", autoSpeakShortcut: "ctrl+shift+j" });
let loaded = cfg.loadConfigWithSource(cwd, { agentDir });
assert.equal(loaded.source, "global");
assert.equal(loaded.config.ttsAutoSpeakMaxChars, 400, "a numeric cap is honoured");
assert.equal(loaded.config.speakShortcut, "ctrl+j", "a valid speakShortcut is honoured");
assert.equal(loaded.config.autoSpeakShortcut, "ctrl+shift+j", "a valid autoSpeakShortcut is honoured");
assert.equal(cfg.loadGlobalVoiceShortcut("speakShortcut", "alt+s", { agentDir }), "ctrl+j", "startup read honours settings");
assert.equal(cfg.loadGlobalVoiceShortcut("autoSpeakShortcut", "alt+a", { agentDir }), "ctrl+shift+j");

// A negative/garbage cap cannot poison the gate.
writeAgent({ ttsAutoSpeakMaxChars: -5 });
assert.equal(cfg.loadConfigWithSource(cwd, { agentDir }).config.ttsAutoSpeakMaxChars, 0, "negative cap clamps to 0 (no cap)");
writeAgent({ ttsAutoSpeakMaxChars: "400" });
assert.equal(cfg.loadConfigWithSource(cwd, { agentDir }).config.ttsAutoSpeakMaxChars, 0, "string cap falls back to the default");

// Invalid shortcut -> default, with a warning rather than a dead key binding.
writeAgent({ speakShortcut: "banana+s" });
assert.equal(cfg.loadConfigWithSource(cwd, { agentDir }).config.speakShortcut, "alt+s", "invalid shortcut rejected");
assert.equal(cfg.loadGlobalVoiceShortcut("speakShortcut", "alt+s", { agentDir }), "alt+s");

// Keys are global-only: a cloned project block must not rebind the terminal.
writeAgent({ speakShortcut: "ctrl+j", autoSpeakShortcut: "ctrl+shift+j", ttsAutoSpeakMaxChars: 400 });
fs.writeFileSync(
	path.join(cwd, ".pi", "settings.json"),
	JSON.stringify({ voice: { speakShortcut: "ctrl+q", autoSpeakShortcut: "ctrl+q" } })
);
loaded = cfg.loadConfigWithSource(cwd, { agentDir });
assert.equal(loaded.source, "project");
assert.equal(loaded.config.speakShortcut, cfg.DEFAULT_CONFIG.speakShortcut, "project block cannot rebind speakShortcut");
assert.equal(
	loaded.config.autoSpeakShortcut,
	cfg.DEFAULT_CONFIG.autoSpeakShortcut,
	"project block cannot rebind autoSpeakShortcut"
);
fs.rmSync(path.join(cwd, ".pi", "settings.json"));

// A project-scoped save must not persist the key bindings either — pi.registerShortcut()
// already ran at load, so a cloned project that ships these keys must not steer the terminal.
const proj2 = path.join(tmp, "proj2");
fs.mkdirSync(proj2, { recursive: true });
cfg.saveConfig(
	{ ...cfg.DEFAULT_CONFIG, scope: "project", speakShortcut: "ctrl+j", autoSpeakShortcut: "ctrl+shift+j" },
	"project",
	proj2
);
const written = JSON.parse(fs.readFileSync(path.join(proj2, ".pi", "settings.json"), "utf8")).voice;
assert.equal(written.speakShortcut, undefined, "project save drops speakShortcut");
assert.equal(written.autoSpeakShortcut, undefined, "project save drops autoSpeakShortcut");

// The same fields DO survive a global save (that is how the keys persist across restarts).
cfg.saveConfig(
	{ ...cfg.DEFAULT_CONFIG, scope: "global", speakShortcut: "ctrl+j", ttsAutoSpeakMaxChars: 400 },
	"global",
	cwd,
	{ agentDir }
);
const globalWritten = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).voice;
assert.equal(globalWritten.speakShortcut, "ctrl+j", "global save persists the key");
assert.equal(globalWritten.ttsAutoSpeakMaxChars, 400, "global save persists the cap");

// ─── 3b. the length probe the cap relies on ─────────────────────────────────
const filter = jiti(FILTER_TS);
const long = "The quick brown fox jumps over the lazy dog. ".repeat(40); // ~1800 chars
const probe = filter.prepareForSpeech(long, { maxChars: 400, stripCodeBlocks: true, collapseLinks: true });
assert.equal(probe.skipped, true, "a reply over the cap is rejected by the probe");
assert.ok(probe.stats.finalChars > 400, "stats.finalChars is the honest spoken length used for the notify");
const shortProbe = filter.prepareForSpeech("Done. Two patches applied, restart pi.", {
	maxChars: 400,
	stripCodeBlocks: true,
	collapseLinks: true,
});
assert.equal(shortProbe.skipped, false, "a short reply passes the probe");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("speak-on-demand self-test: ok");
