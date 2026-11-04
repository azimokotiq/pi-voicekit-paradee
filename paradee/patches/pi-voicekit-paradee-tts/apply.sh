#!/usr/bin/env bash
# Re-apply the Paradee-8M TTS backend to the installed pi-voicekit.
#
# Why: local TTS latency. The Kokoro path (sherpa-onnx OfflineTts,
# kokoro-int8-en-v0_19) measures RTF 2.2-5.1 on this Windows/x64 box — i.e.
# generating a reply takes 2-5x as long as listening to it (298 chars = 33.8 s),
# and sherpa's numThreads makes almost no difference (2.36 -> 2.21 across 2..12
# threads; Kokoro's transformer encoder does not scale here). Paradee-8M
# (https://github.com/sahilmahendrakar/paradee) is Kokoro's af_heart voice
# distilled to 8.07M parameters in one 9 MB int8 ONNX file: RTF 0.12 on ONE
# thread, 0.07 on four — the same 298-character reply in 1.4 s — at UTMOS 4.41
# vs Kokoro's 4.52 and the same WER. Transcribing Paradee's output with the
# local Parakeet-v3 ASR gives 5.6% WER against the source text, so it is not
# mangled speech.
#
# Paradee cannot use sherpa's `kokoro` slot: its graph takes pre-computed
# phoneme ids (`input_ids` int64 [1,T] + `speed` float32 [1]) and returns the
# waveform directly, with the speaker baked in (no voices.bin, no sid). So this
# patch adds a second backend, extensions/voice/tts-paradee.ts, which runs
# onnxruntime-node directly. G2P is `phonemizer` (eSpeak NG compiled to wasm)
# piped through the upstream eSpeak->misaki table, which is mandatory: fed raw
# eSpeak phonemes the model mumbles (upstream reports Whisper WER 31% vs 3%).
#
# Files:
#   fixed/tts-paradee.ts        new module (backend + vendored misaki table)
#   paradee-tts-local-models.patch  catalog entry, files[] installer, install marker
#   paradee-tts-engine.patch        backend dispatch in synthesize()/warmupTts()
#   package.json.patch              onnxruntime-node + phonemizer as optional deps
#
# pi-voicekit lives in node_modules, so pi-auto-update wipes this patch on the
# next version bump (tested against 0.4.2, latest on npm as of 2026-10-17).
# Re-run after any bump: bash ~/.pi/agent/patches/pi-voicekit-paradee-tts/apply.sh
# If upstream ships Paradee itself (check for "paradee" in
# extensions/voice/tts-engine.ts) this script does nothing.
set -u -o pipefail
PKG="$HOME/.pi/agent/npm/node_modules/pi-voicekit"
NPM="$HOME/.pi/agent/npm"
HERE="$(cd "$(dirname "$0")" && pwd)"
MODELS="extensions/voice/tts-local-models.ts"
ENGINE="extensions/voice/tts-engine.ts"
PARADEE="extensions/voice/tts-paradee.ts"
SHLOADER="extensions/voice/sherpa-loader.ts"
PKGJSON="package.json"

[ -d "$PKG" ] || { echo "pi-voicekit not installed at $PKG"; exit 1; }

if grep -q "paradee" "$PKG/$ENGINE" 2>/dev/null; then
	echo "already applied ($(grep -c '' "$PKG/$ENGINE") lines in tts-engine.ts, $(grep -c '' "$PKG/$PARADEE" 2>/dev/null) in tts-paradee.ts)"
else
	fail=0
	for pair in "$MODELS:paradee-tts-local-models.patch" "$ENGINE:paradee-tts-engine.patch" "$SHLOADER:paradee-sherpa-loader.patch" "$PKGJSON:package.json.patch"; do
		target="${pair%%:*}"; patchfile="${pair##*:}"
		if patch "$PKG/$target" < "$HERE/$patchfile"; then
			echo "patched $target"
		else
			echo "PATCH FAILED for $target — upstream code moved; hand-port the change (see README.md)" >&2
			fail=1
		fi
	done
	cp "$HERE/fixed/tts-paradee.ts" "$PKG/$PARADEE" && echo "installed $PARADEE"

	for target in "$MODELS" "$ENGINE" "$PARADEE" "$SHLOADER"; do
		node -e '
const m=require("node:module"),fs=require("fs"),p=require("path");
try{m.stripTypeScriptTypes(fs.readFileSync(p.join(process.argv[1],process.argv[2]),"utf8"),{mode:"strip"});console.log("parse ok:",process.argv[2]);}
catch(e){console.error("parse FAIL:",e.message);process.exit(1);}' "$PKG" "$target" || fail=1
	done
	[ "$fail" -eq 0 ] || exit 1
fi

# The load-order hunk in sherpa-loader.ts is applied separately so an install
# that predates it still gets it (an upgrade of this patch, not a fresh apply).
if ! grep -q "onnxruntime-node" "$PKG/$SHLOADER" 2>/dev/null; then
	if patch "$PKG/$SHLOADER" < "$HERE/paradee-sherpa-loader.patch"; then
		echo "patched $SHLOADER (primes onnxruntime-node before sherpa)"
	else
		echo "PATCH FAILED for $SHLOADER — hand-port the prime (see README.md, 'Load-order constraint')" >&2
		exit 1
	fi
else
	echo "$SHLOADER already primes onnxruntime-node"
fi

# tts-paradee.ts is a whole new module, not a patch hunk: keep the deployed copy
# byte-identical to fixed/ even when the hunks above were already applied, so a
# fix to the module still reaches a live install.
if [ -f "$PKG/$PARADEE" ] && ! cmp -s "$HERE/fixed/tts-paradee.ts" "$PKG/$PARADEE"; then
	cp "$HERE/fixed/tts-paradee.ts" "$PKG/$PARADEE" && echo "re-synced $PARADEE (module changed since it was installed)"
fi

# Runtime deps: Paradee needs onnxruntime-node + phonemizer resolvable from the
# package directory. Install them into the harness npm root if absent.
missing=$(cd "$PKG" && node -e 'for (const d of ["onnxruntime-node","phonemizer"]) { try { require.resolve(d); } catch { console.log(d); } }' 2>/dev/null)
if [ -n "$missing" ]; then
	echo "installing missing deps: $missing"
	(cd "$NPM" && npm i $missing --no-audit --no-fund >/dev/null 2>&1) || echo "npm install failed — install manually: cd $NPM && npm i onnxruntime-node phonemizer" >&2
fi

echo "self-test:"
node "$HERE/test_paradee.mjs" | tail -20
echo "load-order self-test (pi's real order: voice.ts → loadSherpa → Paradee):"
node "$HERE/test_load_order.mjs" | tail -8
