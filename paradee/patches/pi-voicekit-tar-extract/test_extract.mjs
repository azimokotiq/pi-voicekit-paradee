// Self-test for the pi-voicekit tar-extract patch (resolveTar + relative args + EXTRACT_STALL_MS watchdog).
// Proves, on Windows: (1) System32 bsdtar + MSYS bzip2 deadlocks on -xj (the bug),
// (2) the patched runTarExtract picks GNU tar and extracts the same archive byte-exact,
// (3) extractStalled() semantics behind the watchdog.
// Run: node ~/.pi/agent/patches/pi-voicekit-tar-extract/test_extract.mjs
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PI = path.join(os.homedir(), ".pi", "agent", "install", "releases", "1.3.0", "node_modules");
const { createJiti } = require(path.join(PI, "jiti"));
const jiti = createJiti(import.meta.url, { moduleCache: false });

const MOD = path.join(
	os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-voicekit", "extensions", "voice", "tts-local-models.ts",
);
const mod = await jiti.import(MOD);
for (const fn of ["resolveTar", "extractStalled", "runTarExtract"]) {
	if (typeof mod[fn] !== "function") {
		console.error(`FAIL: ${fn} is not exported — patch not applied?`);
		process.exit(1);
	}
}

// ── 1. tar selection ──
const tarBin = mod.resolveTar();
const ver = spawnSync(tarBin, ["--version"], { encoding: "utf8" }).stdout?.split("\n")[0] ?? "(no --version output)";
console.log(`resolveTar() → ${tarBin}\n            → ${ver}`);
if (process.platform === "win32" && !/GNU tar/i.test(ver)) {
	console.error("FAIL: on Windows the selected tar must have internal bzip2 (GNU tar)");
	process.exit(1);
}

// ── 2. watchdog predicate ──
const now = Date.now();
const scratch0 = fs.mkdtempSync(path.join(os.tmpdir(), "ktn-stall-"));
const emptyDir = path.join(scratch0, "empty");
fs.mkdirSync(emptyDir);
if (!mod.extractStalled(emptyDir, now - 61_000, now)) { console.error("FAIL: untouched dir after 61s must count as stalled"); process.exit(1); }
if (mod.extractStalled(emptyDir, now - 1_000, now)) { console.error("FAIL: startup grace period must not trip the watchdog"); process.exit(1); }
fs.writeFileSync(path.join(emptyDir, "fresh.bin"), "x");
if (mod.extractStalled(emptyDir, Date.now() - 61_000, Date.now())) { console.error("FAIL: freshly written file must clear the stall"); process.exit(1); }
fs.writeFileSync(path.join(emptyDir, "stale.bin"), "y");
const old = new Date(Date.now() - 61_000);
fs.utimesSync(path.join(emptyDir, "stale.bin"), old, old);
fs.rmSync(path.join(emptyDir, "fresh.bin"));
if (!mod.extractStalled(emptyDir, Date.now() - 120_000, Date.now())) { console.error("FAIL: only stale entries present → stalled"); process.exit(1); }
if (mod.extractStalled(path.join(scratch0, "nope"), Date.now() - 61_000, Date.now())) { console.error("FAIL: missing dir must not report stalled (real error comes from close)"); process.exit(1); }
fs.rmSync(scratch0, { recursive: true, force: true });
console.log("extractStalled OK (idle 61s→stall, 1s grace→clear, fresh write→clear, only stale→stall, missing dir→no stall)");

// ── 3. fixture, built where production keeps archives: inside the TTS models dir ──
// runTarExtract() computes relative args against getTtsModelsDir(), so the fixture
// has to live there for the relative path branch (and the MSYS colon problem) to be
// exercised at all.
const ttsRoot = path.join(os.homedir(), ".pi", "models", "tts");
fs.mkdirSync(ttsRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(ttsRoot, "tartest-"));
try {
	const srcDir = path.join(scratch, "src");
	fs.mkdirSync(srcDir);
	const blob = Buffer.alloc(8 * 1024 * 1024);
	for (let i = 0; i < blob.length; i++) blob[i] = (i * 2654435761) >>> 24; // >64 KiB so a pipe buffer fills
	fs.writeFileSync(path.join(srcDir, "blob.bin"), blob);
	const made = spawnSync(tarBin, ["-cjf", "fixture.tar.bz2", "blob.bin"], { cwd: srcDir, encoding: "utf8" });
	if (made.status !== 0) { console.error("FAIL to build fixture:", (made.stderr ?? "").trim().slice(0, 300)); process.exit(1); }
	fs.renameSync(path.join(srcDir, "fixture.tar.bz2"), path.join(scratch, "fixture.tar.bz2"));
	console.log(`fixture: ${fs.statSync(path.join(scratch, "fixture.tar.bz2")).size} bytes compressed / 8 MiB uncompressed (in ${scratch})`);

	// ── 4. control: Windows' own tar (bsdtar) — the bug the patch routes around ──
	// The deadlock needs enough decompressed data to fill the pipe, so a small fixture
	// may not reproduce it. Point KTN_TAR_ARCHIVE at a real model archive (tens of MB)
	// to exercise the exact production shape.
	if (process.platform === "win32") {
		const big = process.env.KTN_TAR_ARCHIVE;
		const controlArchive = big && fs.existsSync(big) ? big : path.join(scratch, "fixture.tar.bz2");
		const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
		const cdir = path.join(scratch, "via-bsdtar");
		fs.mkdirSync(cdir);
		const t0 = Date.now();
		const r = spawnSync(systemTar, ["-xj", "-f", controlArchive, "-C", cdir], { cwd: scratch, encoding: "utf8", timeout: 20_000 });
		const label = big && controlArchive === big ? "real archive" : "8 MiB fixture";
		if (r.error?.code === "ETIMEDOUT") {
			console.log(`control: System32 bsdtar + MSYS bzip2 DEADLOCKED on ${label} (no exit in 20s; entries: ${fs.readdirSync(cdir).length}) — this is the bug`);
		} else if (r.status !== 0) {
			console.log(`control: bsdtar failed fast on ${label} — ${(r.stderr ?? "").trim().split("\n")[0]}`);
		} else {
			console.log(`control: bsdtar completed on ${label} in ${Date.now() - t0} ms — deadlock not reproduced at this size`);
		}
	}

	// ── 5. the patched path (absolute inputs; the function relativizes them itself) ──
	const out2 = path.join(scratch, "via-patched");
	fs.mkdirSync(out2);
	const t1 = Date.now();
	await mod.runTarExtract(path.join(scratch, "fixture.tar.bz2"), out2);
	const got = fs.readFileSync(path.join(out2, "blob.bin"));
	if (!got.equals(blob)) { console.error("FAIL: extracted bytes differ"); process.exit(1); }
	console.log(`runTarExtract: 8 MiB extracted byte-exact in ${Date.now() - t1} ms via ${tarBin}`);
	console.log("EXTRACT SELFTEST OK");
} finally {
	try {
		fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
	} catch (e) {
		console.log(`note: could not remove ${scratch} (${e.code ?? e.message}) — delete it by hand`);
	}
}
