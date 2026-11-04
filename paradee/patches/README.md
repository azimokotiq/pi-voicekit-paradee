# Local patches for pi packages

> **In this repo these live at `paradee/patches/`.** They were written to sit in
> `~/.pi/agent/patches/` and patch the *installed* package in
> `~/.pi/agent/npm/node_modules/pi-voicekit`; every path below is relative to that
> home, and `apply_all.sh` derives its own directory, so the directory works from
> either location. The fork tree you are reading was produced by replaying these
> same patches onto the `v0.4.2` tag — `paradee/scripts/replay-patches.sh` does
> exactly that and is what the eight commits on top of `v0.4.2` are.

Everything here is a change to a package that lives in
`~/.pi/agent/npm/node_modules`, which means **any update wipes it**. One command
re-applies all of them in dependency order and self-tests each one:

```
bash ~/.pi/agent/patches/apply_all.sh        # → "all patches applied and self-tested", EXIT=0
```

Each `apply.sh` is idempotent: it greps the installed file for the symbol it
introduces (patch already present) or for the upstream fix (no longer needed) and
does nothing in either case. If a `patch` hunk fails, the script says
`PATCH FAILED — upstream code moved; hand-port the change (see README.md)` and
exits non-zero — that means upstream refactored and the change must be applied by
hand against their new code. **Read the patch's own README before hand-porting.**

Extension modules are loaded at process start, so after applying anything here you
must **restart pi** — a running session cannot pick it up.

## pi-voicekit (0.4.2)

| patch | fixes |
|---|---|
| `pi-voicekit-tar-extract` | model unpack used a tar that isn't resolvable on this machine |
| `pi-voicekit-win-mic-device` | Windows dshow device selection — the "Microphone captured no audio" failure |
| `pi-voicekit-download-retry` | retries transient network errors during model download |
| `pi-voicekit-esc-stops-reply` | Esc / `/voice-speak-stop` now kills the *queued* sentence chunks of a reply, not just the utterance playing |
| `pi-voicekit-no-double-narration` | a fast TTS model finished before `turn_end`, so the legacy fallback re-spoke the whole reply — the reply was narrated twice |
| `pi-voicekit-paradee-tts` | Paradee-8M TTS backend (`onnxruntime-node` + `phonemizer`), multi-file HF installer, warm **RTF 0.08** vs Kokoro ≈2.2 |
| `pi-voicekit-tts-warmup` | calls the exported-but-never-invoked `warmupTts()` at session start — first utterance 4 111 ms → **827 ms** |
| `pi-voicekit-speak-on-demand` | it narrated **every** reply with no length limit and no way to ask for one. Adds `alt+s` (read the last reply / stop), `alt+a` (mute auto-narration only), `/voice-read`, `/voice-autospeak`, and `voice.ttsAutoSpeakMaxChars` (default this rig: 400 spoken chars) |

`pi-voicekit-paradee-tts` also carries `test_load_order.mjs`, which guards the one
landmine in this stack: `sherpa-onnx-node` and `onnxruntime-node` each bundle an
ONNX Runtime and **the one that dlopens second is refused by the Windows loader**,
so `loadSherpa()` must import `onnxruntime-node` first.

Every patch dir has an `upstream-issue.md` — paste-ready for
[CyFeng16/pi-voicekit](https://github.com/CyFeng16/pi-voicekit). **None posted
yet.** Posting them is what makes this directory unnecessary.

## Why updates can't silently break this: the package is pinned

`~/.pi/agent/settings.json` lists `npm:pi-voicekit@0.4.2` (exact), and
`~/.pi/agent/npm/package.json` pins the dependency to `0.4.2`. pi's package
manager starts its update check with

```js
if (parsed.type === "local" || parsed.pinned) return undefined;   // package-manager.js
```

and `pinned` is `semver.valid(version) !== null`, so an exact version is **skipped
by `pi update --extensions`** (same for path-installed extensions). That was
verified on 2026-10-17 by reading pi 1.3.0's `DefaultPackageManager` and by
`pi list` → `npm:pi-voicekit@0.4.2` resolving to the patched install.

Backup of the pre-pin settings: `~/.pi/agent/settings.json.bak-pin-0.4.2`.

To take an upstream update deliberately:

```
pi install npm:pi-voicekit@latest
bash ~/.pi/agent/patches/apply_all.sh      # re-apply + self-test, or report which hunk moved
# restart pi
```

Then re-pin to the new exact version. If upstream has merged a fix, that patch
reports "upstream now …" and does nothing — delete it from `ORDER` in
`apply_all.sh` once all of its hunks are gone.

## Alternative considered: fork it locally

Copying the patched tree to its own package (e.g. `~/pi-paradee`) and installing
by path also escapes auto-update, and removes the patch files entirely. It was
deferred because it moves the dependency problem: `sherpa-onnx-node`,
`onnxruntime-node`, `phonemizer` and the `@earendil-works/pi-tui` peer dep would
have to resolve outside `~/.pi/agent/npm/node_modules`, and we'd own every future
upstream fix as a manual cherry-pick. Pinning gets the same safety for one
settings line.
