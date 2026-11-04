// Self-test for the "esc stops the whole reply" patch (pi-voicekit-esc-stops-reply).
// Loads the PATCHED extensions/voice.ts and checks both the pure helper and the
// wiring that makes Esc/stop cancel the queued chunks, not just the active one.
// Run: node ~/.pi/agent/patches/pi-voicekit-esc-stops-reply/test_esc_stop.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Module from "node:module";
import assert from "node:assert";

const NPM = path.join(os.homedir(), ".pi", "agent", "npm");
const VOICE_TS = path.join(NPM, "node_modules", "pi-voicekit", "extensions", "voice.ts");

// pi's own packages (jiti, @earendil-works/pi-tui) live in the installed
// release's node_modules and NODE_PATH is not exported in every shell (it
// disappeared after a pi restart), so pin the search path here instead of
// relying on the caller's environment.
{
	const relRoot = path.join(os.homedir(), ".pi", "agent", "install", "releases");
	const extra = [];
	try {
		for (const v of fs.readdirSync(relRoot).sort().reverse()) {
			extra.push(path.join(relRoot, v, "node_modules"));
		}
	} catch {}
	// _initPaths() REBUILDS globalPaths from NODE_PATH, so the env must be set
	// first — pushing into Module.globalPaths and then calling _initPaths (an
	// earlier revision of this test did exactly that) silently wipes them.
	process.env.NODE_PATH = [...(process.env.NODE_PATH ? [process.env.NODE_PATH] : []), ...extra].join(path.delimiter);
	if (typeof Module._initPaths === "function") Module._initPaths();
}

const require = Module.createRequire(path.join(NPM, "noop.cjs"));
const jiti = require("jiti")(import.meta.filename);

const src = fs.readFileSync(VOICE_TS, "utf8");
const voice = jiti(VOICE_TS);

assert.equal(typeof voice.cancelMessageStreams, "function", "cancelMessageStreams must be exported from voice.ts");
const streams = new Map([
	["m1", { cancelled: false }],
	["m2", { cancelled: true }],
	["m3", { cancelled: false }],
]);
assert.equal(voice.cancelMessageStreams(streams), 2, "should report the two not-yet-cancelled streams");
assert.deepEqual([...streams.values()], [{ cancelled: true }, { cancelled: true }, { cancelled: true }]);
assert.equal(voice.cancelMessageStreams(streams), 0, "a second stop must be a no-op");
console.log("esc-stop patch — ALL PASS");
console.log("  ✓ cancelMessageStreams flips streams once and reports the drop count");

// Wiring: the pure helper is useless unless every stop affordance routes
// through it and the chunk chain obeys the flag.
const checks = [
	[/function stopSpeechAndQueuedChunks\(\)/, "stopSpeechAndQueuedChunks() exists"],
	[/state\.pending = state\.pending\.then\(async \(\) => \{\s*\n\s*if \(state\.cancelled\) return;/, "chunk chain drops remaining chunks"],
	[/The user stopped this reply — stay silent for the rest of it\.\s*\n\s*if \(state\.cancelled\) return;/, "streaming entry stays silent for a stopped reply"],
	[/onStop: \(\) => stopSpeechAndQueuedChunks\(\)/, "playback indicator stop kills the queue"],
	[/if \(stopSpeechAndQueuedChunks\(\)\) \{/, "/voice-speak-stop kills the queue"],
	[/if \(!nowEnabling\) stopSpeechAndQueuedChunks\(\);/, "disabling TTS kills the queue"],
	[/function startPreRecording\(\) \{\s*\n\s*stopSpeechAndQueuedChunks\(\);/, "push-to-talk kills the queue"],
	[/cancelledMessageIds\.has\(id\)/, "turn_end fallback cannot re-speak a stopped reply"],
	[/abortActiveSpeak\(\);\n\n\t\ttry \{/, null], // must be GONE (startRecording path was converted)
];
for (const [re, label] of checks) {
	if (!label) {
		assert.ok(!re.test(src), "startRecording should call stopSpeechAndQueuedChunks, not abortActiveSpeak");
		continue;
	}
	assert.ok(re.test(src), `missing wiring: ${label}`);
	console.log(`  ✓ ${label}`);
}
const sites = (src.match(/stopSpeechAndQueuedChunks/g) ?? []).length;
assert.ok(sites >= 6, `expected the helper at every stop site, found ${sites} occurrences`);
