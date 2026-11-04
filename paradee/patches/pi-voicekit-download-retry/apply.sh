#!/usr/bin/env bash
# Re-apply the download-retry patch to the installed pi-voicekit.
#
# pi-voicekit lives in node_modules, so pi-auto-update will wipe this patch on the
# next version bump (tested against 0.4.2, the latest as of 2026-10-17). Run this
# after any bump:   bash ~/.pi/agent/patches/pi-voicekit-download-retry/apply.sh
# If upstream ships its own retry (check for "isRetryableNetworkError" in
# extensions/voice/model-download.ts) this script does nothing.
set -u -o pipefail
PKG="$HOME/.pi/agent/npm/node_modules/pi-voicekit"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -d "$PKG" ] || { echo "pi-voicekit not installed at $PKG"; exit 1; }

if grep -q "isRetryableNetworkError" "$PKG/extensions/voice/model-download.ts" 2>/dev/null; then
	echo "already applied ($(grep -c '' "$PKG/extensions/voice/model-download.ts") lines in model-download.ts)"
	exit 0
fi

fail=0
apply() { # apply <target-file-relative-to-pkg> <patch-file>
	if patch "$PKG/$1" < "$HERE/$2"; then
		echo "patched $1"
	else
		echo "PATCH FAILED for $1 — upstream code moved; hand-port the change (see README.md)" >&2
		fail=1
	fi
}
apply "extensions/voice/model-download.ts" "model-download.retry.patch"
apply "extensions/voice.ts" "voice.retry.patch"

# Syntax check without executing (Node strips types natively).
node -e '
const m=require("node:module"),fs=require("fs"),p=require("path");
const pkg=process.argv[1];let bad=0;
for(const f of ["extensions/voice/model-download.ts","extensions/voice.ts"]){
  try{m.stripTypeScriptTypes(fs.readFileSync(p.join(pkg,f),"utf8"),{mode:"strip"});console.log("parse ok:",f);}
  catch(e){console.error("parse FAIL:",f,e.message);bad=1;}
}
process.exit(bad);' "$PKG" || fail=1

if [ "$fail" -eq 0 ]; then
	echo "applied — self-test:"
	node "$HERE/test_retry.mjs" | tail -2
fi
exit $fail
