# Windows: microphone always fails with "captured no audio. Check mic permissions." (dshow device detection regex never matches)

Tested against pi-voicekit **0.4.2** on Windows 11, ffmpeg 4.2.3 (`ffmpeg.exe` from the
ImageMagick install, first on PATH). Local backend, `localModel: parakeet-v3`.

## Symptom

Push-to-talk ends a fraction of a second after starting:

```
Error: Microphone captured no audio. Check mic permissions.
```

The microphone, the OS privacy settings and the model are all fine — nothing was ever
asked of the microphone.

## Root cause

`extensions/voice.ts` (0.4.2) enumerates Windows capture devices like this:

```ts
function detectWindowsAudioDevice(): string | null {
	const result = spawnSync("ffmpeg", ["-f", "dshow", "-list_devices", "true", "-i", "dummy"], { … });
	const output = result.stderr || "";
	// Match lines like: [dshow @ ...] "Microphone (Realtek HD Audio)" (audio)
	const match = output.match(/"([^"]+)"\s*\(audio\)/);
	return match?.[1] || null;
}
```

The `(audio)` suffix is an **avfoundation** (macOS) convention. DirectShow listings do not
carry it. Actual output on this machine:

```
[dshow @ 00000209f8b2a4c0] DirectShow video devices (some may be both video and audio devices)
[dshow @ 00000209f8b2a4c0]  "AnkerWork C310 Webcam"
[dshow @ 00000209f8b2a4c0]     Alternative name "@device_pnp_\\?\usb#vid_291a&pid_3367&mi_00#7&35589d2b&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\global"
[dshow @ 00000209f8b2a4c0] DirectShow audio devices
[dshow @ 00000209f8b2a4c0]  "Microphone (AnkerWork C310 Webcam)"
[dshow @ 00000209f8b2a4c0]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{9481D240-B2A3-42B5-8E0D-632BBE9A0592}"
[dshow @ 00000209f8b2a4c0]  "Microphone (Steam Streaming Microphone)"
[dshow @ 00000209f8b2a4c0]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{7952D960-AB7C-4519-B7B3-B09A4E4B9AFE}"
```

`grep -c "(audio)"` on that text = 0, so the regex never matches and detection returns
`null` on **every** Windows machine. Capture then falls back to the hard-coded guess:

```ts
inputArgs = dshowDevice ? ["-f", "dshow", "-i", `audio=${dshowDevice}`]
                        : ["-f", "dshow", "-i", "audio=Microphone"]; // last-resort guess
```

dshow matches device names exactly, not by prefix, so:

```
[dshow @ …] Could not find audio only device with name [Microphone] among source devices of type audio.
[dshow @ …] Could not find audio only device with name [Microphone] among source devices of type video.
audio=Microphone: I/O error
```

ffmpeg exits, stdout is empty, `stopLocalSession()` hits `if (pcmData.length === 0)` and
calls `onDone("", { hadAudio: false, hadSpeech: false })`, which the UI reports as
"check mic permissions" — a diagnosis the data does not support.

A/B on the same machine, same second:

```
ffmpeg -f dshow -i "audio=Microphone"                     → 0 bytes, I/O error (as above)
ffmpeg -f dshow -i "audio=Microphone (AnkerWork C310 Webcam)" → 95,968 bytes in 4 s
```

## Suggested fix

Parse the listing by section instead of requiring a suffix. This is the helper I run in a
local patch (placed in `extensions/voice/audio-tool.ts`, which `voice.ts` already imports,
so both call sites — `probeFfmpeg` and the settings-panel mic test — get fixed):

```ts
/** Virtual/bridge mics that capture silence unless something is deliberately routed through them. */
const VIRTUAL_AUDIO_DEVICE =
	/steam streaming|vb-audio|vbcable|cable-output|cable-input|virtual audio|voicemeeter|teamviewer|multi-output|sonicstage|nvidia broadcast/i;

function isDeviceHeading(line: string): string | null {
	if (/video devices/i.test(line)) return "video";  // must be checked first: the video
	if (/audio devices/i.test(line)) return "audio";  // heading also says "audio devices"
	return null;
}

export function chooseDshowAudioDevice(output: string): string | null {
	const names: string[] = [];
	let inAudioSection = false;

	for (const raw of output.split(/\r?\n/)) {
		const line = raw.replace(/^\[[^\]]*\]\s*/, ""); // strip "[dshow @ 0x…] "
		if (!line.trim()) continue;

		const heading = isDeviceHeading(line);
		if (heading) { inAudioSection = heading === "audio"; continue; }
		if (/alternative name/i.test(line)) continue;   // the @device_… form is not the friendly name

		const quoted = line.match(/"([^"]+)"/);
		if (!quoted) continue;
		const name = quoted[1].trim();
		if (!name || name.startsWith("@device")) continue;

		const suffixed = line.match(/"[^"]*"\s*\((\w+)\)\s*$/); // avfoundation: "Name" (audio)
		if (suffixed) { if (!/^audio$/i.test(suffixed[1])) continue; }
		else if (!inAudioSection) continue;

		if (!names.includes(name)) names.push(name);
	}

	const real = names.filter((n) => !VIRTUAL_AUDIO_DEVICE.test(n));
	return real[0] ?? names[0] ?? null;
}
```

Memoise it, since `probeFfmpeg` runs the 3 s `-list_devices` spawn:

```ts
let _cachedDshowDevice: string | null | undefined;
export function detectWindowsAudioDevice(listDevices: () => string = listDshowDevices): string | null {
	if (_cachedDshowDevice !== undefined) return _cachedDshowDevice;
	_cachedDshowDevice = chooseDshowAudioDevice(listDevices());
	return _cachedDshowDevice;
}
```

Two related improvements that cost nothing:

1. **Report the capture tool's stderr.** Zero bytes reaches the transcriber for at least
   four different reasons (wrong device name, device busy/exclusive, privacy policy denied,
   no such device), and all four print "Check mic permissions." Remembering the last
   non-noise stderr line and appending it to the notification turns an unactionable error
   into a diagnosis:

   ```ts
   let _lastCaptureStderr = "";
   function noteCaptureStderr(msg: string): void {
   	_lastCaptureStderr = msg.replace(/^\[[^\]]*\]\s*/, "").slice(0, 200);
   }
   // …in the "no audio" branch:
   "Microphone captured no audio. Check mic permissions." + captureErrorSuffix()
   ```

2. **The `audio=Microphone` fallback is dead weight.** Exact-match dshow means a literal
   name only ever works on a machine that happens to have a device named exactly
   `Microphone`. Better to fail loudly ("no capture device found — run
   `ffmpeg -f dshow -list_devices true -i dummy` and pick one") and/or let users pin the
   device in settings; there is currently no config key for the input device, so a Windows
   user with several mics cannot choose which one is used, nor avoid a virtual bridge mic
   that captures silence.

## Environment gotchas found along the way

- `commandExists("ffmpeg")` uses `where ffmpeg`, which resolves to whichever ffmpeg is first
  on PATH — on this box that is ImageMagick's ffmpeg 4.2.3. It works for dshow, but it is
  an easy source of confusion; logging the resolved path plus the final argv once
  (`voiceDebug("local capture:", audioTool.name, audioTool.args.join(" "))`) saved hours
  of debugging.
- ffmpeg's `-list_devices` output goes to **stderr**, which the current code already relies
  on — good, but it means any future "log ffmpeg stderr" change must not treat that
  listing as an error.
- The device input level is not checked anywhere. A mic at 0 % Windows input gain produces
  bytes (so `hadAudio === true`) with peak sample ≈ 1, which surfaces as
  "captured silence — no speech detected" rather than "your input level is muted". A cheap
  peak check over the buffered PCM would let the error say that.
