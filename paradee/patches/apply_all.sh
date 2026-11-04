#!/usr/bin/env bash
# Apply every pi-voicekit patch in dependency order, then self-test each.
#
# pi-voicekit installs under ~/.pi/agent/npm/node_modules, so pi-auto-update
# wipes ALL of these on any version bump. Run this once after each bump:
#
#   bash ~/.pi/agent/patches/apply_all.sh
#
# Order matters only for pi-voicekit-esc-stops-reply, whose context lines come
# from a voice.ts that already has pi-voicekit-win-mic-device applied, and for
# pi-voicekit-speak-on-demand, whose hunks sit inside code added by
# pi-voicekit-esc-stops-reply and pi-voicekit-no-double-narration (so it goes last).
# Each apply.sh is idempotent: if upstream ships the fix (they grep for the
# upstream-bound symbol), it reports "already applied" and does nothing.
#
# pi-voicekit is PINNED to an exact version (settings.json packages entry
# "npm:pi-voicekit@0.4.2"), and pi's updater skips pinned and path-installed
# sources — so an update can only happen when you pin a new version on purpose.
# See README.md in this directory for the update ritual and the per-patch notes.
set -u -o pipefail
BASE="$(cd "$(dirname "$0")" && pwd)"
ORDER=(
	pi-voicekit-tar-extract
	pi-voicekit-win-mic-device
	pi-voicekit-download-retry
	pi-voicekit-esc-stops-reply
	pi-voicekit-no-double-narration
	pi-voicekit-paradee-tts
	pi-voicekit-tts-warmup
	pi-voicekit-speak-on-demand
)
fail=0
for p in "${ORDER[@]}"; do
	echo "── $p"
	out="$(mktemp)"
	if bash "$BASE/$p/apply.sh" >"$out" 2>&1; then
		grep -vE "ExperimentalWarning|trace-warnings" "$out" | tail -14
	else
		fail=1
		grep -vE "ExperimentalWarning|trace-warnings" "$out"
		echo "   ^ $p exited non-zero" >&2
	fi
	rm -f "$out"
done
echo
if [ "$fail" -eq 0 ]; then
	echo "all patches applied and self-tested"
else
	echo "SOME PATCH FAILED — check the output above (upstream code likely moved; hand-port)" >&2
fi
exit $fail
