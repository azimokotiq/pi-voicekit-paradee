#!/usr/bin/env bash
# Re-apply the Windows microphone-device patch to the installed pi-voicekit.
#
# Why: on Windows, capture runs `ffmpeg -f dshow -i audio=<name>`, and dshow has no
# "default" alias — the name must be enumerated. voice.ts (0.4.2) enumerated it with
#   output.match(/"([^"]+)"\s*\(audio\)/)
# but dshow listings carry no "(audio)" suffix (that suffix is an avfoundation/macOS
# convention), so detection ALWAYS returned null and capture fell back to the literal
#   -i audio=Microphone
# dshow matches device names exactly, so ffmpeg exits with
#   Could not find audio only device with name [Microphone] among source devices of type audio
# zero bytes reach the transcriber, and the UI blames mic permissions:
#   "Microphone captured no audio. Check mic permissions."
# (observed 2026-10-17: 0 bytes for the fallback vs 95,968 bytes in 4 s for
#  "Microphone (AnkerWork C310 Webcam)" — the microphone and permissions were fine.)
#
# Fix: parse the "DirectShow audio devices" section into a shared helper in
# extensions/voice/audio-tool.ts (chooseDshowAudioDevice + cached
# detectWindowsAudioDevice, virtual bridge mics de-prioritised), and append the last
# capture stderr line to the "captured no audio" notification so a broken pipeline is
# no longer misdiagnosed as a permissions problem.
#
# pi-voicekit lives in node_modules, so pi-auto-update wipes this patch on the next
# version bump (tested against 0.4.2, latest on npm as of 2026-10-17). Re-run after
# any bump:  bash ~/.pi/agent/patches/pi-voicekit-win-mic-device/apply.sh
# If upstream fixes it (check for "chooseDshowAudioDevice" in extensions/voice/audio-tool.ts)
# this script does nothing.
set -u -o pipefail
PKG="$HOME/.pi/agent/npm/node_modules/pi-voicekit"
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOL="extensions/voice/audio-tool.ts"
VOICE="extensions/voice.ts"

[ -d "$PKG" ] || { echo "pi-voicekit not installed at $PKG"; exit 1; }

if grep -q "chooseDshowAudioDevice" "$PKG/$TOOL" 2>/dev/null; then
	echo "already applied ($(grep -c '' "$PKG/$TOOL") lines in audio-tool.ts, $(grep -c '' "$PKG/$VOICE") lines in voice.ts)"
	exit 0
fi

fail=0
for pair in "$TOOL:audio-tool.patch" "$VOICE:voice-capture.patch"; do
	target="${pair%%:*}"; patchfile="${pair##*:}"
	if patch "$PKG/$target" < "$HERE/$patchfile"; then
		echo "patched $target"
	else
		echo "PATCH FAILED for $target — upstream code moved; hand-port the change (see README.md)" >&2
		fail=1
	fi
done

# Syntax check without executing (Node strips types natively).
for target in "$TOOL" "$VOICE"; do
	node -e '
const m=require("node:module"),fs=require("fs"),p=require("path");
try{m.stripTypeScriptTypes(fs.readFileSync(p.join(process.argv[1],process.argv[2]),"utf8"),{mode:"strip"});console.log("parse ok:",process.argv[2]);}
catch(e){console.error("parse FAIL:",e.message);process.exit(1);}' "$PKG" "$target" || fail=1
done

if [ "$fail" -eq 0 ]; then
	echo "applied — self-test:"
	node "$HERE/test_mic_detect.mjs" | tail -14
fi
exit $fail
