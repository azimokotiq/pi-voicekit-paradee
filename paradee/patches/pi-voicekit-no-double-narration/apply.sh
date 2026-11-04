#!/usr/bin/env bash
# Re-apply the "no double narration" patch to installed pi-voicekit.
#
# Why: 0.4.2 has two auto-speak paths for one assistant reply — the streaming
# path (message_update / message_end, chunked at sentence boundaries) and a
# "legacy turn_end fallback". The fallback's only guard is
#     const state = messageStreams.get(id);
#     if (state || cancelledMessageIds.has(id)) return;
# but message_end DELETES that state as soon as the last chunk finishes playing
# (`state.pending.finally(() => messageStreams.delete(id))`). So the guard is a
# race: if speech has finished by the time turn_end fires, "no state" reads as
# "nobody spoke this" and the fallback re-speaks the entire reply.
#
# It only shows up with a fast model. Kokoro (RTF ~1.1) was still speaking when
# turn_end arrived, so state existed and the fallback correctly skipped; Paradee
# (RTF 0.085) finishes a 10 s utterance in ~0.9 s, the state is gone, and every
# reply gets narrated twice. Also: `lastAutoSpeakAt` — the 3000 ms limiter meant
# to stop exactly this — was written ONLY by the fallback, never by the streaming
# path, so it could never help.
#
# Fix: a bounded FIFO `spokenMessageIds` (same shape as the cancelledMessageIds
# added by pi-voicekit-esc-stops-reply). message_end marks the reply spoken when
# the stream actually queued something (spokenLen > 0), turn_end refuses it, and
# the streaming path now updates lastAutoSpeakAt as a second line of defence for
# the case where the two paths disagree about the message id. The fallback still
# fires when nothing was queued (e.g. the mic was hot at message_end), and it now
# logs "turn_end fallback speak" so the race is visible in PI_VOICE_DEBUG output.
#
# ORDERING: apply AFTER pi-voicekit-esc-stops-reply — these hunks' context lines
# contain cancelledMessageIds/markReplyCancelled, which that patch introduces.
#
# pi-voicekit lives in node_modules, so an update would wipe this patch; the
# package is pinned to an exact version (see ../README.md), so an update can only
# happen when you pin a new version deliberately. Re-run after any bump.
set -u -o pipefail
PKG="$HOME/.pi/agent/npm/node_modules/pi-voicekit"
HERE="$(cd "$(dirname "$0")" && pwd)"
VOICE="extensions/voice.ts"

[ -d "$PKG" ] || { echo "pi-voicekit not installed at $PKG"; exit 1; }

if grep -q "spokenMessageIds" "$PKG/$VOICE" 2>/dev/null; then
	echo "already applied ($(grep -c '' "$PKG/$VOICE") lines in voice.ts)"
else
	if ! patch "$PKG/$VOICE" < "$HERE/no-double-narration.patch"; then
		echo "PATCH FAILED — upstream code moved; hand-port the change (see README.md)" >&2
		exit 1
	fi
	node -e '
const m=require("node:module"),fs=require("fs"),p=require("path");
try{m.stripTypeScriptTypes(fs.readFileSync(p.join(process.argv[1],process.argv[2]),"utf8"),{mode:"strip"});console.log("parse ok:",process.argv[2]);}
catch(e){console.error("parse FAIL:",e.message);process.exit(1);}' "$PKG" "$VOICE" || exit 1
fi

echo "self-test:"
node "$HERE/test_no_double_narration.mjs"
