#!/usr/bin/env bash
# Re-apply the "speak on demand" patch to installed pi-voicekit.
#
# Why: pi-voicekit narrates EVERY assistant reply (voice.ttsAutoSpeak defaults
# true, the only length limit is a hard 2000-char cut inside prepareForSpeech),
# and the only switch is the TTS master toggle — silencing narration also kills
# /voice-speak. There is no way to ask for one reply out loud.
#
# What it adds (three files touched, two of them):
#   voice/config.ts
#     voice.ttsAutoSpeakMaxChars  — spoken-char cap for auto-narration, 0 = off
#                                   (default 0 keeps upstream behaviour)
#     voice.speakShortcut         — default "alt+s"
#     voice.autoSpeakShortcut     — default "alt+a"
#     loadGlobalVoiceShortcut()   — startup reader, mirrors loadGlobalToggleShortcut
#     serializeConfig             — the two keys stay global-only
#   voice.ts
#     alt+s   → speakLastReplyOrStop(): stop if something is playing, else read
#               the last assistant reply on the branch (sessionManager.getBranch)
#     alt+a   → setAutoSpeak(): mute/unmute ttsAutoSpeak WITHOUT touching
#               ttsEnabled, so on-demand reading keeps working while muted
#     /voice-read [text]          — same as alt+s; with an argument, reads that
#     /voice-autospeak [on|off|status|<maxChars>] — cap + mute from the keyboard
#     cap in maybeSpeakNew(): with a cap set the streaming path BUFFERS until
#               message_end (total length is unknowable mid-stream), then either
#               speaks the whole reply or stays silent and says so. The
#               turn_end fallback applies the same cap and marks the reply
#               handled via markReplySpoken so the two paths can't disagree.
#
# ORDERING: apply LAST. Its hunks sit inside code introduced by
# pi-voicekit-esc-stops-reply (cancelledMessageIds) and
# pi-voicekit-no-double-narration (markReplySpoken/spokenMessageIds).
#
# pi-voicekit lives in node_modules, so an update would wipe this patch; the
# package is pinned to an exact version (see ../README.md), so an update can only
# happen when you pin a new version deliberately. Re-run after any bump.
set -u -o pipefail
PKG="$HOME/.pi/agent/npm/node_modules/pi-voicekit"
HERE="$(cd "$(dirname "$0")" && pwd)"
VOICE="extensions/voice.ts"
CONFIG="extensions/voice/config.ts"

[ -d "$PKG" ] || { echo "pi-voicekit not installed at $PKG"; exit 1; }

if grep -q "ttsAutoSpeakMaxChars" "$PKG/$CONFIG" 2>/dev/null && grep -q "loadGlobalVoiceShortcut" "$PKG/$CONFIG" 2>/dev/null; then
	echo "already applied ($(grep -c '' "$PKG/$VOICE") lines in voice.ts, $(grep -c '' "$PKG/$CONFIG") in config.ts)"
else
	ok=1
	patch "$PKG/$VOICE" < "$HERE/speak-on-demand.patch" || ok=0
	patch "$PKG/$CONFIG" < "$HERE/autospeak-config.patch" || ok=0
	if [ "$ok" -eq 0 ]; then
		echo "PATCH FAILED — upstream code moved; hand-port the change (see README.md)" >&2
		exit 1
	fi
	node -e '
const m=require("node:module"),fs=require("fs"),p=require("path");
for (const f of process.argv.slice(2)) {
try{m.stripTypeScriptTypes(fs.readFileSync(p.join(process.argv[1],f),"utf8"),{mode:"strip"});console.log("parse ok:",f);}
catch(e){console.error("parse FAIL:",f,e.message);process.exit(1);}}' "$PKG" "$VOICE" "$CONFIG" || exit 1
fi

echo "self-test:"
node "$HERE/test_speak_on_demand.mjs"
