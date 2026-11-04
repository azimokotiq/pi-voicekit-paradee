/**
 * Capture-tool preference.
 *
 * SoX' `rec` is the best default for local capture, but it is known to stall on
 * network PulseAudio servers: over an SSH audio tunnel (`PULSE_SERVER` pointing at
 * a forwarded TCP port, e.g. `tcp:127.0.0.1:4713`) the same `rec` invocation
 * returned zero bytes in 40% of runs on this stack, while ffmpeg was reliable in
 * every run. So when a remote Pulse server is configured, probe ffmpeg first and
 * keep SoX as the fallback; local capture keeps SoX first.
 */

import { spawnSync } from "node:child_process";

export type AudioToolName = "ffmpeg" | "sox" | "arecord";

export function audioToolOrder(env: { PULSE_SERVER?: string | undefined } = process.env): AudioToolName[] {
	return env.PULSE_SERVER ? ["ffmpeg", "sox", "arecord"] : ["sox", "ffmpeg", "arecord"];
}

/**
 * Windows DirectShow capture device detection.
 *
 * dshow has no "default" alias: ffmpeg must be handed an exact `audio=<name>`
 * argument, so the name has to be enumerated first. ffmpeg prints the listing to
 * STDERR, in this shape (verified with ffmpeg 4.2.3 on Windows 11, 2026-10-17):
 *
 *   [dshow @ 000001f8] DirectShow video devices (some may be both video and audio devices)
 *   [dshow @ 000001f8]  "AnkerWork C310 Webcam"
 *   [dshow @ 000001f8]      Alternative name "@device_pnp_\\?\usb#vid_291a&...\global"
 *   [dshow @ 000001f8] DirectShow audio devices
 *   [dshow @ 000001f8]  "Microphone (AnkerWork C310 Webcam)"
 *   [dshow @ 000001f8]      Alternative name "@device_cm_{33D9A762-...}\wave_{9481D240-...}"
 *
 * dshow output carries NO "(audio)" suffix — that suffix is an avfoundation
 * (macOS) convention. A parser requiring it returns null on every Windows box,
 * which sends capture down the `audio=Microphone` last-resort path; dshow matches
 * device names exactly, so ffmpeg fails with
 *   Could not find audio only device with name [Microphone] among source devices of type audio
 * and zero bytes of audio ever reach the transcriber — which the UI reports as
 * "Microphone captured no audio. Check mic permissions.", i.e. a wrong diagnosis.
 */

/** Virtual/bridge mics that capture silence unless something is deliberately routed through them. */
const VIRTUAL_AUDIO_DEVICE =
	/steam streaming|vb-audio|vbcable|cable-output|cable-input|virtual audio|voicemeeter|teamviewer|multi-output|sonicstage|nvidia broadcast/i;

/** Heading lines of the listing, e.g. "DirectShow audio devices". */
function isDeviceHeading(line: string): string | null {
	if (/video devices/i.test(line)) return "video";
	if (/audio devices/i.test(line)) return "audio";
	return null;
}

/**
 * Parse a dshow/avfoundation device listing and pick a capture device name.
 * Pure function — takes the stderr text so it is testable without a microphone.
 */
export function chooseDshowAudioDevice(output: string): string | null {
	const names: string[] = [];
	let inAudioSection = false;

	for (const raw of output.split(/\r?\n/)) {
		const line = raw.replace(/^\[[^\]]*\]\s*/, ""); // strip "[dshow @ 0x…] "
		if (!line.trim()) continue;

		const heading = isDeviceHeading(line);
		if (heading) {
			inAudioSection = heading === "audio";
			continue;
		}
		if (/alternative name/i.test(line)) continue; // the @device_… form is not the friendly name

		const quoted = line.match(/"([^"]+)"/);
		if (!quoted) continue;
		const name = quoted[1].trim();
		if (!name || name.startsWith("@device")) continue;

		// avfoundation-style suffix: "Name" (audio) / "Name" (video)
		const suffixed = line.match(/"[^"]*"\s*\((\w+)\)\s*$/);
		if (suffixed) {
			if (!/^audio$/i.test(suffixed[1])) continue;
		} else if (!inAudioSection) {
			continue;
		}

		if (!names.includes(name)) names.push(name);
	}

	const real = names.filter((n) => !VIRTUAL_AUDIO_DEVICE.test(n));
	return real[0] ?? names[0] ?? null;
}

function listDshowDevices(): string {
	try {
		const result = spawnSync("ffmpeg", ["-f", "dshow", "-list_devices", "true", "-i", "dummy"], {
			timeout: 3000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return result.stderr || ""; // ffmpeg outputs the device list to stderr
	} catch {
		return "";
	}
}

let _cachedDshowDevice: string | null | undefined;

/** Cached "first usable audio input device name", or null if none could be determined. */
export function detectWindowsAudioDevice(listDevices: () => string = listDshowDevices): string | null {
	if (_cachedDshowDevice !== undefined) return _cachedDshowDevice;
	_cachedDshowDevice = chooseDshowAudioDevice(listDevices());
	return _cachedDshowDevice;
}
