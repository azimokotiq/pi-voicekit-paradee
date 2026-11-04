# pi-voicekit patch #3 — Windows microphone device detection

**Target:** pi-voicekit **0.4.2** (`~/.pi/agent/npm/node_modules/pi-voicekit/`), files
`extensions/voice.ts` (md5 `3eb4e509dcd855b13fe82d93897f0a00` → `01dda691d567cc74654b4ae222a22da2`,
4014 → 4011 lines) and `extensions/voice/audio-tool.ts`
(md5 `3ca401fc63ed5c96afa01803b1590c4e` → `8bcb5229dae8657192bac0d725a57da8`, 16 → 113 lines).

## Symptom

Hold-to-talk / push-to-talk ends almost immediately with

```
Error: Microphone captured no audio. Check mic permissions.
```

Microphone, Windows privacy settings and Parakeet TDT v3 are all fine.

## Root cause (verified 2026-10-17)

Capture on Windows runs `ffmpeg -f dshow -i audio=<device name>`; dshow has no `default`
alias, so the name must be enumerated first. pi-voicekit 0.4.2 enumerated it with

```ts
// voice.ts:255-270
const match = output.match(/"([^"]+)"\s*\(audio\)/);
```

DirectShow listings carry **no `(audio)` suffix** — that suffix is an avfoundation (macOS)
convention. Real output from this machine (ffmpeg 4.2.3, the ImageMagick build on PATH):

```
[dshow @ …] DirectShow video devices (some may be both video and audio devices)
[dshow @ …]  "AnkerWork C310 Webcam"
[dshow @ …]     Alternative name "@device_pnp_\\?\usb#vid_291a&…\global"
[dshow @ …] DirectShow audio devices
[dshow @ …]  "Microphone (AnkerWork C310 Webcam)"
[dshow @ …]     Alternative name "@device_cm_{33D9A762-…}\wave_{9481D240-…}"
[dshow @ …]  "Microphone (Steam Streaming Microphone)"
```

`grep -c "(audio)"` on that output = **0**, so detection always returns null and the code
falls back to `voice.ts:319`:

```ts
inputArgs = dshowDevice ? […] : ["-f", "dshow", "-i", "audio=Microphone"]; // last-resort guess
```

dshow matches device names **exactly** (not by prefix), so:

```
[dshow @ …] Could not find audio only device with name [Microphone] among source devices of type audio.
audio=Microphone: I/O error
```

→ stdout stays empty → `stopLocalSession()` sees `pcmData.length === 0`
(`voice/local.ts:1041`) → `onDone("", { hadAudio: false })` → the *permissions* message.
The message is a misdiagnosis: nothing was asked of the microphone at all.

Side effect worth knowing: the notification cannot distinguish "device name wrong" from
"device busy" from "privacy policy denied" — all three print the same sentence.

## Fix

1. `extensions/voice/audio-tool.ts` gains the shared, cached Windows detector:
   - `chooseDshowAudioDevice(output: string): string | null` — pure parser: tracks the
     `DirectShow audio devices` section (video section checked first, because its heading
     itself contains the words "audio devices"), skips `Alternative name` lines and
     `@device_…` names, still understands the `"Name" (audio)` avfoundation suffix form,
     and de-prioritises virtual bridge mics (`steam streaming|vb-audio|vbcable|…`) so a
     silent virtual device is never preferred over real hardware.
   - `detectWindowsAudioDevice(listDevices = listDshowDevices)` — memoised wrapper;
     injectable listing source for tests.
2. `extensions/voice.ts` imports that detector instead of defining the broken local one
   (fixes both call sites: `probeFfmpeg` at `voice.ts:318` and the settings mic test at
   `voice.ts:3110`).
3. Diagnostics: capture-tool stderr is remembered (`noteCaptureStderr` /
   `captureErrorSuffix`) and appended to the "captured no audio" notification, and the
   chosen command line is logged via `voiceDebug("local capture:", …)`. A wrong device
   name, a busy device or a denied policy now say so instead of blaming permissions.

## Apply

```bash
bash ~/.pi/agent/patches/pi-voicekit-win-mic-device/apply.sh
```

Idempotent — greps for `chooseDshowAudioDevice` in `extensions/voice/audio-tool.ts` and
does nothing if it is present (i.e. upstream fixed it). **pi-auto-update wipes node_modules
patches: re-run after any version bump**, together with the other two:

```bash
bash ~/.pi/agent/patches/pi-voicekit-download-retry/apply.sh
bash ~/.pi/agent/patches/pi-voicekit-tar-extract/apply.sh
bash ~/.pi/agent/patches/pi-voicekit-win-mic-device/apply.sh
```

Restart pi afterwards (extension modules are loaded at startup), then push-to-talk
(`ctrl+shift+v`).

## Verify

```bash
node ~/.pi/agent/patches/pi-voicekit-win-mic-device/test_mic_detect.mjs
```

Covers: the stock regex finds nothing in real dshow output (the bug), the patched parser
picks `"Microphone (AnkerWork C310 Webcam)"`, virtual-mic ordering, the avfoundation
suffix form, empty/video-only listings, and a **live** capture comparison —
`audio=Microphone` → 0 bytes + `Could not find audio only device`, patched device →
47,968 bytes / peak 1280 with music playing in the room.

Amplitude note: a quiet room legitimately yields peak ≈ 1, so the amplitude assertion only
runs with `KTN_REQUIRE_SIGNAL=1` (play music). On this machine the mic input level is low:
raw peak ≈ 2000/32767 (≈ −24 dBFS) for music at conversational volume, and `-af volume=40dB`
already saturates. Parakeet handles it, but raising the Windows input level
(`mmsys.cpl` → Recording → Levels) gives the model more headroom.

## Files

| file | role |
|---|---|
| `apply.sh` | idempotent installer + parse check + self-test |
| `audio-tool.patch`, `voice-capture.patch` | `diff -u` against stock 0.4.2 |
| `orig/`, `fixed/` | stock and patched copies (md5s above) |
| `test_mic_detect.mjs` | self-test incl. live ffmpeg capture A/B |
| `upstream-issue.md` | paste-ready issue for `CyFeng16/pi-voicekit` (not posted) |
| `~/micdbg/` | scratch: `devlist.txt` (real dshow listing), `gainprobe.mjs` (level probe) |
