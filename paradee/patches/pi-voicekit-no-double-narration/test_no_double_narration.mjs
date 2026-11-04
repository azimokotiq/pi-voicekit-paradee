// Self-test for pi-voicekit-no-double-narration.
// Asserts the race is closed in the INSTALLED file: message_end records that the
// streaming path spoke, and turn_end honours that record. Run:
//   node ~/.pi/agent/patches/pi-voicekit-no-double-narration/test_no_double_narration.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert";

const SRC = path.join(
	os.homedir(),
	".pi",
	"agent",
	"npm",
	"node_modules",
	"pi-voicekit",
	"extensions",
	"voice.ts"
);
const src = fs.readFileSync(SRC, "utf8");

const checks = [
	["tombstone set declared", /const spokenMessageIds = new Set<string>\(\);/],
	["tombstone marker defined", /function markReplySpoken\(id: string\): void \{/],
	["marker bounded like the others", /spokenMessageIds\.size > 64/],
	// message_end: mark after the flush, and only when the stream queued speech.
	[
		"message_end marks the reply spoken",
		/await maybeSpeakNew\(id, fullText, true\);[\s\S]{0,700}?if \(flushed && flushed\.spokenLen > 0\) \{\s*\n\s*markReplySpoken\(id\);/,
	],
	["nothing queued is not marked", /if \(flushed && flushed\.spokenLen > 0\)/],
	// turn_end: the fallback must refuse a reply the streaming path already spoke.
	["turn_end guard honours the tombstone", /if \(state \|\| cancelledMessageIds\.has\(id\) \|\| spokenMessageIds\.has\(id\)\) return;/],
	// streaming path also feeds the rate limiter, which is the belt for the
	// suspenders: it suppresses a fallback duplicate even if the ids disagree.
	["streaming path updates the rate limiter", /markReplySpoken\(id\);\s*\n\s*lastAutoSpeakAt = Date\.now\(\);/],
	// observability: a fallback speak is now visible in the debug log.
	["fallback speak is logged", /voiceDebug\("turn_end fallback speak"/],
];

for (const [label, re] of checks) assert.ok(re.test(src), `MISSING: ${label}`);

// Exactly one declaration each — a duplicated hunk would mean the patch was
// applied twice (apply.sh guards on this too, but the test must stand alone).
for (const [label, re] of [
	["spokenMessageIds", /const spokenMessageIds = new Set<string>\(\);/g],
	["markReplySpoken", /function markReplySpoken\(/g],
	["turn_end fallback speak", /voiceDebug\("turn_end fallback speak"/g],
]) {
	assert.equal((src.match(re) ?? []).length, 1, `${label} must appear exactly once`);
}

// The old, race-prone guard must be gone.
assert.ok(
	!/if \(state \|\| cancelledMessageIds\.has\(id\)\) return;/.test(src),
	"the un-tombstoned turn_end guard is still present"
);

console.log(`pi-voicekit-no-double-narration: ${checks.length} wiring checks + 3 uniqueness checks PASS`);
