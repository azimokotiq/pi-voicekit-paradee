#!/usr/bin/env bash
# Re-apply the "esc stops the whole reply" patch to the installed pi-voicekit.
#
# Why: auto-speak streams a reply in sentence-sized chunks and chains them
#   state.pending = state.pending.then(async () => { await runSpeak(ctx, text) })
# but every stop affordance only aborted the ACTIVE utterance:
#   - TtsPlaybackIndicator onStop  -> abortActiveSpeak()   (voice.ts:3732)
#   - /voice-speak-stop             -> abortActiveSpeak()  (voice.ts:3855)
#   - TTS disable / start recording -> abortActiveSpeak()
# So every chunk already queued behind the current one kept starting, and
# pressing Esc "kept restarting on the next paragraph" however often you
# pressed it. There was no way to stop a long spoken reply.
#
# Fix: a per-message `cancelled` flag on MessageStreamState. A user-initiated
# stop flips it for every live stream (cancelMessageStreams), the chunk chain
# checks it before synthesizing the next chunk, and the turn_end fallback
# remembers cancelled message ids so it does not re-speak them. All stop
# affordances now call stopSpeechAndQueuedChunks() instead of abortActiveSpeak().
#
# ORDERING: apply AFTER ~/.pi/agent/patches/pi-voicekit-win-mic-device (the
# context lines here were taken from a mic-patched 0.4.2 voice.ts).
#
# pi-voicekit lives in node_modules, so pi-auto-update wipes this patch on the
# next version bump (tested against 0.4.2, latest on npm as of 2026-10-17).
# Re-run after any bump: bash ~/.pi/agent/patches/pi-voicekit-esc-stops-reply/apply.sh
# If upstream fixes it (check for "stopSpeechAndQueuedChunks" in
# extensions/voice.ts) this script does nothing.
set -u -o pipefail
PKG="$HOME/.pi/agent/npm/node_modules/pi-voicekit"
HERE="$(cd "$(dirname "$0")" && pwd)"
VOICE="extensions/voice.ts"

[ -d "$PKG" ] || { echo "pi-voicekit not installed at $PKG"; exit 1; }

if grep -q "stopSpeechAndQueuedChunks" "$PKG/$VOICE" 2>/dev/null; then
	echo "already applied ($(grep -c '' "$PKG/$VOICE") lines in voice.ts)"
else
	if ! patch "$PKG/$VOICE" < "$HERE/esc-stop.patch"; then
		echo "PATCH FAILED — upstream code moved; hand-port the change (see README.md)" >&2
		exit 1
	fi
	node -e '
const m=require("node:module"),fs=require("fs"),p=require("path");
try{m.stripTypeScriptTypes(fs.readFileSync(p.join(process.argv[1],process.argv[2]),"utf8"),{mode:"strip"});console.log("parse ok:",process.argv[2]);}
catch(e){console.error("parse FAIL:",e.message);process.exit(1);}' "$PKG" "$VOICE" || exit 1
fi

echo "self-test:"
node "$HERE/test_esc_stop.mjs" | tail -10
