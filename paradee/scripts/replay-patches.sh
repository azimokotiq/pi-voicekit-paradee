#!/usr/bin/env bash
# Rebuild this fork's source tree from a pristine pi-voicekit v0.4.2 checkout.
#
#   git clone --branch v0.4.2 https://github.com/CyFeng16/pi-voicekit.git /tmp/vk
#   bash paradee/scripts/replay-patches.sh /tmp/vk
#
# The eight patch directories under paradee/patches/ are the same files that keep
# the *installed* package patched in ~/.pi/agent/npm/node_modules (pi-voicekit is
# a node_modules install, so pi's auto-update wipes it on every version bump; the
# patches are what re-apply the work). Here they are replayed onto a source
# checkout instead, in dependency order, so the fork tree is provably the same
# bytes the patches produce.
#
# Order matters. Each patch's hunks were cut against the tree as left by the
# previous one:
#   - esc-stops-reply needs win-mic-device's voice.ts
#   - no-double-narration needs esc-stops-reply's cancelledMessageIds
#   - speak-on-demand needs both (its hunks sit inside their code)
#   - paradee-tts needs nothing from voice.ts, but its tts-local-models hunk
#     follows tar-extract's
set -u -o pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: $0 <path to a pi-voicekit v0.4.2 checkout>" >&2; exit 2; }
[ -f "$TARGET/extensions/voice.ts" ] || { echo "$TARGET does not look like pi-voicekit" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
PATCHES="$(cd "$HERE/../patches" && pwd)"

apply() { # apply <patch-dir> <target-relative-to-pkg> <patch-file>
	local dir="$1" target="$2" file="$3"
	if patch -l --no-backup-if-mismatch "$TARGET/$target" <"$PATCHES/$dir/$file" >/dev/null; then
		echo "  patched $target  ($dir)"
	else
		echo "  FAILED  $target  ($dir/$file)" >&2
		return 1
	fi
}

fail=0
echo "── tar-extract (model unpack without an external tar)"
apply pi-voicekit-tar-extract extensions/voice/tts-local-models.ts tar-extract.patch || fail=1

echo "── win-mic-device (dshow device selection)"
apply pi-voicekit-win-mic-device extensions/voice/audio-tool.ts audio-tool.patch || fail=1
apply pi-voicekit-win-mic-device extensions/voice.ts voice-capture.patch || fail=1

echo "── download-retry (transient network errors)"
apply pi-voicekit-download-retry extensions/voice/model-download.ts model-download.retry.patch || fail=1
apply pi-voicekit-download-retry extensions/voice.ts voice.retry.patch || fail=1

echo "── esc-stops-reply (stop the queued chunks, not just the utterance)"
apply pi-voicekit-esc-stops-reply extensions/voice.ts esc-stop.patch || fail=1

echo "── no-double-narration (fast TTS raced the turn_end fallback)"
apply pi-voicekit-no-double-narration extensions/voice.ts no-double-narration.patch || fail=1

echo "── paradee-tts (the backend itself)"
apply pi-voicekit-paradee-tts extensions/voice/tts-local-models.ts paradee-tts-local-models.patch || fail=1
apply pi-voicekit-paradee-tts extensions/voice/tts-engine.ts paradee-tts-engine.patch || fail=1
apply pi-voicekit-paradee-tts extensions/voice/sherpa-loader.ts paradee-sherpa-loader.patch || fail=1
apply pi-voicekit-paradee-tts package.json package.json.patch || fail=1
# tts-paradee.ts and the G2P worker are whole new modules, not hunks.
cp "$PATCHES/pi-voicekit-paradee-tts/fixed/tts-paradee.ts" "$TARGET/extensions/voice/tts-paradee.ts" || fail=1
echo "  added   extensions/voice/tts-paradee.ts"
cp "$PATCHES/pi-voicekit-paradee-tts/fixed/paradee-g2p-worker.mjs" "$TARGET/extensions/voice/paradee-g2p-worker.mjs" || fail=1
echo "  added   extensions/voice/paradee-g2p-worker.mjs"

echo "── tts-warmup (call warmupTts at session start)"
apply pi-voicekit-tts-warmup extensions/voice.ts tts-warmup.patch || fail=1

echo "── speak-on-demand (alt+s / alt+a, autospeak cap)"
apply pi-voicekit-speak-on-demand extensions/voice.ts speak-on-demand.patch || fail=1
apply pi-voicekit-speak-on-demand extensions/voice/config.ts autospeak-config.patch || fail=1

echo
if [ "$fail" -eq 0 ]; then
	echo "replayed 8 patches — tree rebuilt"
else
	echo "SOME PATCH FAILED (upstream moved?) — see messages above" >&2
fi
exit "$fail"
