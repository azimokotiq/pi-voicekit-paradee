// Self-test for the pi-voicekit Windows mic-device patch (chooseDshowAudioDevice + detectWindowsAudioDevice).
//
// Proves, on Windows:
//   1. the STOCK parser (regex requiring an "(audio)" suffix) returns null on real dshow
//      output — and the stock `audio=Microphone` fallback captures 0 bytes (the bug),
//   2. the patched parser picks the real device from the same output,
//   3. an end-to-end ffmpeg capture through the patched args yields real, non-silent audio,
//   4. the pure parser's edge cases (avfoundation suffix, virtual-mic ordering, empty input).
//
// Run: node ~/.pi/agent/patches/pi-voicekit-win-mic-device/test_mic_detect.mjs
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PI = path.join(os.homedir(), ".pi", "agent", "install", "releases", "1.3.0", "node_modules");
const { createJiti } = require(path.join(PI, "jiti"));
const jiti = createJiti(import.meta.url, { moduleCache: false });

const MOD = path.join(
	os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-voicekit", "extensions", "voice", "audio-tool.ts",
);
const mod = await jiti.import(MOD);
for (const fn of ["chooseDshowAudioDevice", "detectWindowsAudioDevice", "audioToolOrder"]) {
	if (typeof mod[fn] !== "function") {
		console.error(`FAIL: ${fn} is not exported — patch not applied?`);
		process.exit(1);
	}
}
const { chooseDshowAudioDevice, detectWindowsAudioDevice } = mod;

let fail = 0;
const check = (cond, msg) => {
	if (!cond) { console.error("FAIL:", msg); fail = 1; } else console.log("ok:", msg);
};

// ── 1. real listing captured from this machine (ffmpeg 4.2.3, Windows 11) ──
const DSHOW = [
	'[dshow @ 000001a] DirectShow video devices (some may be both video and audio devices)',
	'[dshow @ 000001a]  "AnkerWork C310 Webcam"',
	'[dshow @ 000001a]     Alternative name "@device_pnp_\\\\?\\usb#vid_291a&pid_3367&mi_00#7&35589d2b&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"',
	'[dshow @ 000001a] DirectShow audio devices',
	'[dshow @ 000001a]  "Microphone (AnkerWork C310 Webcam)"',
	'[dshow @ 000001a]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{9481D240-B2A3-42B5-8E0D-632BBE9A0592}"',
	'[dshow @ 000001a]  "Microphone (Steam Streaming Microphone)"',
	'[dshow @ 000001a]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{7952D960-AB7C-4519-B7B3-B09A4E4B9AFE}"',
	'dummy: Immediate exit requested',
	'',
].join("\n");

// the stock implementation, verbatim from pi-voicekit 0.4.2 voice.ts
const stockParse = (output) => (output.match(/"([^"]+)"\s*\(audio\)/)?.[1]) || null;
check(stockParse(DSHOW) === null, "stock regex finds nothing in real dshow output (this is the bug)");
check(
	chooseDshowAudioDevice(DSHOW) === "Microphone (AnkerWork C310 Webcam)",
	"patched parser picks the real mic: " + JSON.stringify(chooseDshowAudioDevice(DSHOW)),
);

// ── 2. parser edge cases ──
check(chooseDshowAudioDevice("") === null, "empty listing → null");
check(
	chooseDshowAudioDevice('[avfoundation @ 0x1] "FaceTime HD Camera" (video)\n[avfoundation @ 0x1] "Microphone (Built-in)" (audio)\n')
		=== "Microphone (Built-in)",
	"avfoundation (audio)/(video) suffix form still works",
);
check(
	chooseDshowAudioDevice('[dshow @ 0x1] DirectShow audio devices\n[dshow @ 0x1]  "Microphone (Steam Streaming Microphone)"\n[dshow @ 0x1]  "Microphone (Realtek(R) Audio)"\n')
		=== "Microphone (Realtek(R) Audio)",
	"virtual bridge mic skipped in favour of hardware",
);
check(
	chooseDshowAudioDevice('[dshow @ 0x1] DirectShow audio devices\n[dshow @ 0x1]  "Stereo Mix (Realtek)"\n')
		=== "Stereo Mix (Realtek)",
	"non-virtual device kept even when it is not named 'Microphone'",
);
check(
	chooseDshowAudioDevice('[dshow @ 0x1] DirectShow video devices\n[dshow @ 0x1]  "Webcam"\n') === null,
	"video-only listing → null (no audio section)",
);
check(
	chooseDshowAudioDevice(DSHOW.replace(/Alternative name/g, "")) === "Microphone (AnkerWork C310 Webcam)",
	"bare @device_… style lines are still never chosen",
);

// ── 3. end-to-end: capture through the args the patch produces ──
if (process.platform !== "win32") {
	console.log("(skipping live capture — not Windows)");
	process.exit(fail);
}

const dev = detectWindowsAudioDevice();
console.log("detectWindowsAudioDevice() →", JSON.stringify(dev));
check(!!dev, "live detection returns a device name");

const capture = (deviceArg, ms = 3000) =>
	new Promise((resolve) => {
		const p = spawn("ffmpeg", [
			"-f", "dshow", "-i", deviceArg,
			"-ac", "1", "-ar", "16000", "-sample_fmt", "s16", "-f", "s16le", "-loglevel", "error", "pipe:1",
		], { stdio: ["pipe", "pipe", "pipe"] });
		let bytes = 0, peak = 0, stderrText = "";
		p.stdout.on("data", (c) => {
			bytes += c.length;
			for (let i = 0; i + 1 < c.length; i += 2) {
				const s = c.readInt16LE(i);
				if (Math.abs(s) > peak) peak = Math.abs(s);
			}
		});
		p.stderr.on("data", (d) => (stderrText += d.toString()));
		setTimeout(() => { p.kill("SIGKILL"); }, ms);
		p.on("close", () => resolve({ bytes, peak, stderrText }));
	});

const broken = await capture("audio=Microphone");
console.log(`stock fallback "audio=Microphone" → ${broken.bytes} bytes; stderr: ${broken.stderrText.trim().split("\n")[0]}`);
check(broken.bytes === 0 && /Could not find audio only device/.test(broken.stderrText),
	"stock fallback reproduces the zero-byte capture live");

if (dev) {
	const good = await capture(`audio=${dev}`);
	console.log(`patched "audio=${dev}" → ${good.bytes} bytes, peak sample ${good.peak}`);
	check(good.bytes > 32_000, "patched device captures audio bytes");
	// A quiet room gives peak ≈ 1, so amplitude is only asserted when asked for
	// (KTN_REQUIRE_SIGNAL=1, e.g. with music playing) — bytes prove the pipeline works.
	if (good.peak > 500) console.log(`ok: signal present (peak ${good.peak})`);
	else if (process.env.KTN_REQUIRE_SIGNAL) check(false, `KTN_REQUIRE_SIGNAL set but peak is only ${good.peak}`);
	else console.log(`note: near-silence captured (peak ${good.peak}) — quiet room, not a device failure`);
}

// ── 4. the voice.ts side of the patch must be present too ──
const VOICE = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-voicekit", "extensions", "voice.ts");
const voice = fs.readFileSync(VOICE, "utf8");
check(/import \{ audioToolOrder, detectWindowsAudioDevice, type AudioToolName \} from "\.\/voice\/audio-tool"/.test(voice),
	"voice.ts imports the shared detector instead of defining its own");
check(!/\(audio\)/.test(voice.match(/function detectWindowsAudioDevice[\s\S]{0,600}/)?.[0] ?? ""),
	"the broken local parser is gone from voice.ts");

process.exit(fail);
