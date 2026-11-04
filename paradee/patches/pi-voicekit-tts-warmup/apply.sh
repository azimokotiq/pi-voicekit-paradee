#!/usr/bin/env bash
# Re-apply the "warm the TTS model at session start" patch to installed pi-voicekit.
#
# Why: voice/tts-engine.ts exports warmupTts() and NOTHING calls it (grep the
# package: the symbol appears only at its own definition). So the first spoken
# reply of every pi process pays the model load inside that reply:
#   paradee-8m-v1_0  first utterance 4111 ms, then RTF 0.080 (8.65 s audio in 696 ms)
#   kokoro-int8      first utterance ~1.9 s
#   kitten-nano      similar
# i.e. ~4 s of the user's first reply is a hidden model load, and every later
# utterance is 30-50x faster. Upstream even documents the trick for the
# punctuation engine at session_start ("no dictation ever waits for a background
# build") — this patch applies the same idea to speech output.
#
# Fix: module-scope `warmupSelectedTts(getConfig, reason)` in extensions/voice.ts
# — gated on ttsEnabled + local backend + model installed, keyed on model id in a
# Set so it runs once per model, never throws, never blocks. Called from three
# places: session_start (right after preparePunctuation), /voice-speak-toggle when
# enabling, and finalizeAndSaveSetup (so a model picked in the settings panel is
# resident before the next reply).
#
# ORDERING: apply AFTER pi-voicekit-win-mic-device and pi-voicekit-esc-stops-reply
# (the toggle hunk's context contains stopSpeechAndQueuedChunks).
#
# pi-voicekit lives in node_modules, so pi-auto-update wipes this patch on the
# next version bump (tested against 0.4.2, latest on npm as of 2026-10-17).
# Re-run after any bump: bash ~/.pi/agent/patches/pi-voicekit-tts-warmup/apply.sh
# If upstream ships it themselves (they'd call warmupTts from voice.ts), this
# script detects "warmupSelectedTts"/"warmupTts(" in voice.ts and does nothing.
set -u -o pipefail
PKG="$HOME/.pi/agent/npm/node_modules/pi-voicekit"
HERE="$(cd "$(dirname "$0")" && pwd)"
VOICE="extensions/voice.ts"

[ -d "$PKG" ] || { echo "pi-voicekit not installed at $PKG"; exit 1; }

if grep -q "warmupSelectedTts" "$PKG/$VOICE" 2>/dev/null; then
	echo "already applied ($(grep -c '' "$PKG/$VOICE") lines in voice.ts)"
elif grep -qE "(await |void )warmupTts\(" "$PKG/$VOICE" 2>/dev/null; then
	echo "upstream now warms TTS on its own — patch not needed"
else
	if ! patch "$PKG/$VOICE" < "$HERE/tts-warmup.patch"; then
		echo "PATCH FAILED — upstream code moved; hand-port the change (see README.md)" >&2
		exit 1
	fi
	node -e '
const m=require("node:module"),fs=require("fs"),p=require("path");
try{m.stripTypeScriptTypes(fs.readFileSync(p.join(process.argv[1],process.argv[2]),"utf8"),{mode:"strip"});console.log("parse ok:",process.argv[2]);}
catch(e){console.error("parse FAIL:",e.message);process.exit(1);}' "$PKG" "$VOICE" || exit 1
fi

echo "self-test:"
node "$HERE/test_warmup.mjs"
