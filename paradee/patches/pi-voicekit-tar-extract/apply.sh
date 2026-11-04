#!/usr/bin/env bash
# Re-apply the tar-extract patch to the installed pi-voicekit.
#
# Why: local TTS/Piper/Kokoro model archives are .tar.bz2 and pi-voicekit extracts
# them with `spawn("tar", ["-xj", ...])`. On Windows that resolves to
# C:\Windows\System32\tar.exe (bsdtar) regardless of shell, because CreateProcess
# searches System32 before PATH — and bsdtar has no internal bzip2: `-j` runs the
# external filter "bzip2 -d". If Git Bash's MSYS bzip2.exe is on PATH the pipe
# deadlocks and the install hangs at "Extracting…" forever (observed 2026-10-17:
# 50 minutes, tar at 0.03s CPU, 141,559 bytes read / 65,536 written).
# Fix: prefer a GNU tar (internal bzip2) found on PATH by absolute path, and kill
# any extraction that writes nothing for 60s so a wedge becomes an error message.
#
# pi-voicekit lives in node_modules, so pi-auto-update wipes this patch on the next
# version bump (tested against 0.4.2, latest on npm as of 2026-10-17). Re-run after
# any bump:  bash ~/.pi/agent/patches/pi-voicekit-tar-extract/apply.sh
# If upstream fixes it (check for "resolveTar" in extensions/voice/tts-local-models.ts)
# this script does nothing.
set -u -o pipefail
PKG="$HOME/.pi/agent/npm/node_modules/pi-voicekit"
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="extensions/voice/tts-local-models.ts"

[ -d "$PKG" ] || { echo "pi-voicekit not installed at $PKG"; exit 1; }

if grep -q "resolveTar" "$PKG/$TARGET" 2>/dev/null; then
	echo "already applied ($(grep -c '' "$PKG/$TARGET") lines in tts-local-models.ts)"
	exit 0
fi

fail=0
if patch "$PKG/$TARGET" < "$HERE/tar-extract.patch"; then
	echo "patched $TARGET"
else
	echo "PATCH FAILED for $TARGET — upstream code moved; hand-port the change (see README.md)" >&2
	fail=1
fi

# Syntax check without executing (Node strips types natively).
node -e '
const m=require("node:module"),fs=require("fs"),p=require("path");
try{m.stripTypeScriptTypes(fs.readFileSync(p.join(process.argv[1],process.argv[2]),"utf8"),{mode:"strip"});console.log("parse ok:",process.argv[2]);}
catch(e){console.error("parse FAIL:",e.message);process.exit(1);}' "$PKG" "$TARGET" || fail=1

if [ "$fail" -eq 0 ]; then
	echo "applied — self-test:"
	node "$HERE/test_extract.mjs" | tail -6
fi
exit $fail
