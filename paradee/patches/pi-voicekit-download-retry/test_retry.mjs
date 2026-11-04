// Self-test for the patched pi-voicekit downloader:
// proves a mid-transfer connection reset is retried and RESUMED from the .tmp bytes.
// Run: node ~/.pi/agent/patches/pi-voicekit-download-retry/test_retry.mjs
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PI = path.join(os.homedir(), ".pi", "agent", "install", "releases", "1.3.0", "node_modules");
const { createJiti } = require(path.join(PI, "jiti"));
const jiti = createJiti(import.meta.url, { moduleCache: false });

const MOD = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-voicekit", "extensions", "voice", "model-download.ts");
const mdl = await jiti.import(MOD);

// ── unit: classification ──
const wrap = (code, msg) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(msg), { code }) });
const cases = [
	[wrap("ECONNRESET", "read ECONNRESET"), true],
	[wrap("UND_ERR_SOCKET", "other side closed"), true],
	[Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), true],
	[Object.assign(new Error("user aborted"), { name: "AbortError" }), false],
	[Object.assign(new Error("Body Timeout Error"), { name: "TimeoutError" }), false],
	[Object.assign(new Error("EPERM rename"), { code: "EPERM" }), false],
];
for (const [err, want] of cases) {
	const got = mdl.isRetryableNetworkError(err);
	if (got !== want) { console.error(`FAIL classify ${err.code || err.name}: got ${got} want ${want}`); process.exit(1); }
}
const desc = mdl.describeError(wrap("ECONNRESET", "read ECONNRESET"));
if (!desc.includes("ECONNRESET")) { console.error("FAIL describeError:", desc); process.exit(1); }
console.log(`classify OK (${cases.length} cases) · describeError → "${desc}"`);

// ── integration: reset-and-resume ──
const TOTAL = 2 * 1024 * 1024;
const payload = Buffer.alloc(TOTAL, 0x41); // deterministic
let requests = [];
let resetAt = [0.35, 0.7]; // fraction of the requested range to send before RST-ing, per attempt
const server = http.createServer((req, res) => {
	const range = /bytes=(\d+)-/.exec(req.headers.range || "");
	const start = range ? parseInt(range[1], 10) : 0;
	requests.push({ range: req.headers.range || null, start });
	const slice = payload.subarray(start);
	res.writeHead(range ? 206 : 200, { "content-length": String(slice.length), "content-type": "application/octet-stream" });
	const plan = resetAt[requests.length - 1];
	if (plan === undefined) {
		res.end(slice);
		return;
	}
	// Send a fraction of the declared body, then RST the connection (ECONNRESET).
	res.write(slice.subarray(0, Math.floor(slice.length * plan)));
	setTimeout(() => res.socket?.resetAndDestroy?.(), 30);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/big.bin`;

const modelId = "_retry_selftest";
const dir = path.join(os.homedir(), ".pi", "models", modelId);
fs.rmSync(dir, { recursive: true, force: true });

const retries = [];
let lastProgress = null;
const t0 = Date.now();
const out = await mdl.downloadModel(
	{ modelId, files: { big: url }, totalSizeBytes: TOTAL },
	(p) => { lastProgress = p; },
	undefined,
	(r) => retries.push(r)
);
const elapsed = Date.now() - t0;

const finalPath = path.join(dir, "big.bin");
const size = fs.statSync(finalPath).size;
const ok = size === TOTAL && payload.equals(fs.readFileSync(finalPath));
const tmpLeft = fs.existsSync(finalPath + ".tmp");

console.log(`attempts=${requests.length} retries=${retries.length} (${retries.map((r) => `${r.resumeAt}B@${r.retryInMs}ms`).join(", ")})`);
console.log(`requests: ${JSON.stringify(requests)}`);
console.log(`final=${size} expected=${TOTAL} bytesEqual=${ok} tmpLeft=${tmpLeft} progress=${lastProgress?.downloadedBytes}/${lastProgress?.totalBytes} (${elapsed} ms)`);

fs.rmSync(dir, { recursive: true, force: true });
server.close();

if (!ok || tmpLeft || retries.length < 2 || requests.length < 3 || lastProgress?.downloadedBytes !== TOTAL) {
	console.error("RETRY SELFTEST FAIL");
	process.exit(1);
}
console.log("RETRY SELFTEST OK — reset at 35% and 70% recovered by Range-resume; progress never double-counted");
