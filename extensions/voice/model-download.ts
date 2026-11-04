/**
 * Model download manager — auto-download ONNX models for local transcription.
 *
 * Downloads from sherpa-onnx GitHub releases and HuggingFace.
 * Defaults to int8 quantized models for smaller downloads and lower RAM usage.
 *
 * Storage: ~/.pi/models/{modelId}/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModelDownloadConfig {
	/** Model identifier (e.g., "whisper-small") */
	modelId: string;
	/** Map of role → download URL */
	files: Record<string, string>;
	/** Expected total download size in bytes (for progress reporting) */
	totalSizeBytes: number;
}

export interface DownloadProgress {
	downloadedBytes: number;
	totalBytes: number;
	file: string;
	fileIndex: number;
	totalFiles: number;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

/** Get the base models directory (~/.pi/models/) */
export function getModelsDir(): string {
	return path.join(os.homedir(), ".pi", "models");
}

/** Get the directory for a specific model */
export function getModelDir(modelId: string): string {
	return path.join(getModelsDir(), modelId);
}

/** Get the path for a specific model file */
export function getModelPath(modelId: string): string | null {
	const dir = getModelDir(modelId);
	if (!fs.existsSync(dir)) return null;
	return dir;
}

// ─── Status checks ───────────────────────────────────────────────────────────

/** Check if a model is fully downloaded (all expected files present). */
export function isModelDownloaded(modelId: string, expectedFiles: Record<string, string>): boolean {
	const dir = getModelDir(modelId);
	if (!fs.existsSync(dir)) return false;

	for (const role of Object.keys(expectedFiles)) {
		const filename = fileNameFromUrl(expectedFiles[role]!);
		const filePath = path.join(dir, filename);
		if (!fs.existsSync(filePath)) return false;
	}
	return true;
}

/** List downloaded models with disk usage. */
export function getDownloadedModels(): { id: string; sizeMB: number }[] {
	const baseDir = getModelsDir();
	if (!fs.existsSync(baseDir)) return [];

	const results: { id: string; sizeMB: number }[] = [];
	try {
		const entries = fs.readdirSync(baseDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const modelDir = path.join(baseDir, entry.name);
			const size = getDirSizeMB(modelDir);
			results.push({ id: entry.name, sizeMB: size });
		}
	} catch {
		// Permission error
	}
	return results;
}

/** Delete a downloaded model. */
export function deleteModel(modelId: string): boolean {
	const dir = getModelDir(modelId);
	if (!fs.existsSync(dir)) return false;
	try {
		fs.rmSync(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

// ─── Transport-error classification ─────────────────────────────────────────
//
// huggingface.co intermittently RSTs TLS connections (curl: "Recv failure:
// Connection was reset"; Node: TypeError "fetch failed" with cause
// ECONNRESET). Global fetch itself has no retry policy, so a single reset used
// to abort a multi-hundred-MB install with the opaque message "fetch failed".
// These helpers classify and unwrap such errors so the retry loop below can
// resume instead of giving up, and so the UI can show the real cause.

/** Connection-level failure codes worth retrying. */
const RETRYABLE_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ETIMEDOUT",
	"EPIPE",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);

/** Unwrap err.cause chains: AbortError/TimeoutError never retried, known socket codes always are. */
export function isRetryableNetworkError(err: unknown): boolean {
	let cursor: any = err;
	let depth = 0;
	while (cursor && depth++ < 6) {
		if (cursor.name === "AbortError" || cursor.name === "TimeoutError") return false;
		if (typeof cursor.code === "string" && RETRYABLE_CODES.has(cursor.code)) return true;
		if (typeof cursor.message === "string" && /socket hang up|other side closed|terminated\b|fetch failed/i.test(cursor.message))
			return true;
		cursor = cursor.cause;
	}
	return false;
}

/** Flatten the cause chain into one line: "fetch failed — ECONNRESET: read ECONNRESET". */
export function describeError(err: unknown): string {
	const parts: string[] = [];
	let cursor: any = err;
	let depth = 0;
	while (cursor && depth++ < 5) {
		const msg = typeof cursor.message === "string" ? cursor.message : String(cursor);
		parts.push(cursor.code ? `${msg} (${cursor.code})` : msg);
		cursor = cursor.cause;
	}
	return [...new Set(parts)].join(" — ");
}

/** Abortable sleep used between retry attempts. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true }
		);
	});
}

/** Retry notification surfaced to the UI. */
export interface DownloadRetry {
	file: string;
	attempt: number;
	maxAttempts: number;
	/** Unwrapped cause chain of the failure that triggered the retry. */
	error: string;
	/** Bytes already on disk that the next attempt resumes from (0 if the server refused Range). */
	resumeAt: number;
	/** Delay before the next attempt, in ms. */
	retryInMs: number;
}

/** Max attempts per file (each attempt resumes from the .tmp file via Range). */
const DOWNLOAD_MAX_ATTEMPTS = 8;

/**
 * Download all model files for a given model config.
 * Returns the model directory path.
 *
 * Features:
 * - Progress callbacks per file and overall
 * - Resume support via HTTP Range headers (partial downloads)
 * - Atomic writes (download to .tmp, rename on success)
 * - Abort support via AbortSignal
 * - Transport-error retry with backoff: a mid-transfer connection reset resumes
 *   the same file from the .tmp bytes already written (up to 8 attempts/file)
 */
export async function downloadModel(
	config: ModelDownloadConfig,
	onProgress?: (progress: DownloadProgress) => void,
	signal?: AbortSignal,
	onRetry?: (retry: DownloadRetry) => void
): Promise<string> {
	const dir = getModelDir(config.modelId);
	fs.mkdirSync(dir, { recursive: true });

	const roles = Object.keys(config.files);
	// Bytes safely on disk for files already renamed. overallDownloaded is derived
	// from this + the current .tmp size on every attempt, so resumed bytes are
	// never double-counted in the progress bar after a retry.
	let bytesCommitted = 0;

	for (let i = 0; i < roles.length; i++) {
		const role = roles[i]!;
		const url = config.files[role]!;
		const filename = fileNameFromUrl(url);
		const filePath = path.join(dir, filename);
		const tmpPath = filePath + ".tmp";

		// Skip if already downloaded
		if (fs.existsSync(filePath)) {
			bytesCommitted += fs.statSync(filePath).size;
			continue;
		}

		for (let attempt = 1; ; attempt++) {
			// Check for partial download (resume support) — recomputed per attempt
			const startByte = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
			let overallDownloaded = bytesCommitted + startByte;

			const headers: Record<string, string> = {};
			if (startByte > 0) {
				headers["Range"] = `bytes=${startByte}-`;
			}

			try {
				const resp = await fetch(url, {
					headers,
					signal,
					redirect: "follow",
				});

				if (!resp.ok && resp.status !== 206) {
					throw new Error(`Download failed: HTTP ${resp.status} for ${filename}`);
				}

				// If we requested a Range but server returned 200 (full file), reset to overwrite
				// to avoid appending the full content to an existing partial file
				let resumeFrom = startByte;
				if (startByte > 0 && resp.status === 200) {
					overallDownloaded -= startByte; // undo the partial credit
					resumeFrom = 0;
				}

				if (!resp.body) throw new Error(`No response body for ${filename}`);

				const writeStream = fs.createWriteStream(tmpPath, { flags: resumeFrom > 0 ? "a" : "w" });
				const reader = resp.body.getReader();
				let writeError: unknown = null;

				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						// Write Uint8Array directly (no Buffer.from copy needed)
						// Handle backpressure to avoid unbounded memory on slow disks
						if (!writeStream.write(value)) {
							await new Promise<void>((resolve, reject) => {
								const onDrain = () => {
									writeStream.removeListener("error", onError);
									resolve();
								};
								const onError = (err: Error) => {
									writeStream.removeListener("drain", onDrain);
									reject(err);
								};
								writeStream.once("drain", onDrain);
								writeStream.once("error", onError);
							});
						}
						overallDownloaded += value.byteLength;

						onProgress?.({
							downloadedBytes: overallDownloaded,
							totalBytes: config.totalSizeBytes,
							file: filename,
							fileIndex: i,
							totalFiles: roles.length,
						});
					}
				} finally {
					// Flush and close before either renaming or retrying, so the
					// .tmp size on the next attempt reflects every byte received.
					writeStream.end();
					await new Promise<void>((resolve) => {
						writeStream.on("finish", resolve);
						writeStream.on("error", (err) => {
							writeError = err;
							resolve();
						});
					});
				}

				// Disk write failures (ENOSPC, EACCES) must not be retried or renamed over.
				if (writeError) throw writeError;

				// Atomic rename .tmp → final
				fs.renameSync(tmpPath, filePath);
				bytesCommitted += fs.statSync(filePath).size;
				break; // file complete
			} catch (err: any) {
				const resumeAt = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
				const canRetry = !signal?.aborted && attempt < DOWNLOAD_MAX_ATTEMPTS && isRetryableNetworkError(err);
				if (!canRetry) {
					// Surface the real cause (undici says only "fetch failed" otherwise).
					if (err instanceof Error && !(err.message.startsWith("Download failed: HTTP"))) {
						const detail = describeError(err);
						if (detail && detail !== err.message) throw new Error(`${err.message} — ${detail}`);
					}
					throw err;
				}
				const retryInMs = Math.min(1000 * attempt, 5000);
				onRetry?.({ file: filename, attempt, maxAttempts: DOWNLOAD_MAX_ATTEMPTS, error: describeError(err), resumeAt, retryInMs });
				await sleep(retryInMs, signal);
			}
		}
	}

	return dir;
}

// ─── In-flight deduplication ──────────────────────────────────────────────────
// Prevents concurrent downloads of the same model from corrupting shared .tmp files.
const _inFlight = new Map<string, Promise<string>>();

/**
 * Ensure a model is downloaded, downloading if needed.
 * This is the main entry point for the transcription engine.
 * Deduplicates concurrent calls for the same model — second caller
 * joins the first download instead of starting a parallel one.
 */
export async function ensureModelDownloaded(
	modelId: string,
	expectedFiles: Record<string, string>,
	totalSizeBytes: number,
	onProgress?: (progress: DownloadProgress) => void,
	signal?: AbortSignal,
	onRetry?: (retry: DownloadRetry) => void
): Promise<string> {
	if (isModelDownloaded(modelId, expectedFiles)) {
		return getModelDir(modelId);
	}

	// Join existing download if one is already in progress
	if (_inFlight.has(modelId)) {
		return _inFlight.get(modelId)!;
	}

	const promise = downloadModel(
		{ modelId, files: expectedFiles, totalSizeBytes },
		onProgress,
		signal,
		onRetry
	).finally(() => _inFlight.delete(modelId));

	_inFlight.set(modelId, promise);
	return promise;
}

// ─── Pre-download checks ─────────────────────────────────────────────────────

export interface PreCheckResult {
	ok: boolean;
	issues: string[];
}

/**
 * Run all pre-download checks before starting a model download.
 * Returns a list of issues (empty = all clear).
 *
 * Checks:
 * 1. Disk space (model size + 20% buffer)
 * 2. Network connectivity (HEAD request to first download URL)
 * 3. Write permissions on models directory
 */
export async function checkDownloadPrereqs(
	downloadUrls: Record<string, string>,
	totalSizeBytes: number
): Promise<PreCheckResult> {
	const issues: string[] = [];

	// 1. Disk space
	const requiredBytes = Math.ceil(totalSizeBytes * 1.2); // 20% buffer for .tmp files
	const freeBytes = getFreeDiskSpace(getModelsDir());
	if (freeBytes !== null && freeBytes < requiredBytes) {
		const freeMB = Math.round(freeBytes / (1024 * 1024));
		const needMB = Math.round(requiredBytes / (1024 * 1024));
		issues.push(`Insufficient disk space: ${freeMB} MB free, need ${needMB} MB`);
	}

	// 2. Write permissions
	const modelsDir = getModelsDir();
	try {
		fs.mkdirSync(modelsDir, { recursive: true });
		const testFile = path.join(modelsDir, ".write-test");
		fs.writeFileSync(testFile, "");
		fs.unlinkSync(testFile);
	} catch {
		issues.push(`Cannot write to models directory: ${modelsDir}`);
	}

	// 3. Network connectivity — retried, because connection resets to the model
	//    CDN are intermittent (a single RST should not block a 670 MB install).
	const firstUrl = Object.values(downloadUrls)[0];
	if (firstUrl) {
		let lastErr: any = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const resp = await fetch(firstUrl, {
					method: "HEAD",
					signal: AbortSignal.timeout(8000),
					redirect: "follow",
				});
				// 4xx/5xx = the model URL is wrong or the CDN is down; 3xx we did not
				// follow only when redirects are handled manually, which is fine.
				if (resp.status >= 400) {
					issues.push(`Model server returned HTTP ${resp.status} — check URL or try again later`);
				}
				lastErr = null;
				break;
			} catch (err: any) {
				lastErr = err;
				if (!isRetryableNetworkError(err) || attempt >= 3) break;
				await sleep(1000 * attempt);
			}
		}
		if (lastErr) {
			if (lastErr?.name === "TimeoutError" || lastErr?.name === "AbortError") {
				issues.push("Network timeout — check your internet connection");
			} else if (lastErr?.cause?.code === "ECONNREFUSED" || lastErr?.cause?.code === "ENOTFOUND") {
				issues.push("Cannot reach model server — check your internet connection");
			} else {
				issues.push(`Network error: ${describeError(lastErr)}`);
			}
		}
	}

	return { ok: issues.length === 0, issues };
}

// ─── Download progress formatting ────────────────────────────────────────────

export interface RichProgress {
	/** "45%" */
	percent: number;
	/** "168 MB / 375 MB" */
	sizeLabel: string;
	/** "2.1 MB/s" */
	speed: string;
	/** "~1m 30s left" */
	eta: string;
	/** Full formatted line */
	line: string;
	/** Current file being downloaded */
	file: string;
	/** File progress "2/3" */
	fileProgress: string;
}

/**
 * Create a throttled progress formatter that calculates speed and ETA.
 * Returns a function that accepts raw DownloadProgress and emits RichProgress
 * at most once per `intervalMs` (default 500ms).
 */
export function createProgressTracker(
	modelName: string,
	intervalMs = 500
): (raw: DownloadProgress) => RichProgress | null {
	let startTime = 0;
	let lastEmitTime = 0;
	// Rolling window for speed calculation (last 5 samples)
	const samples: { time: number; bytes: number }[] = [];

	return (raw: DownloadProgress): RichProgress | null => {
		const now = Date.now();
		if (startTime === 0) startTime = now;

		// Throttle emissions
		if (now - lastEmitTime < intervalMs && raw.downloadedBytes < raw.totalBytes) {
			return null;
		}
		lastEmitTime = now;

		// Rolling speed (last 5 samples over ~2.5s window)
		samples.push({ time: now, bytes: raw.downloadedBytes });
		if (samples.length > 10) samples.shift();

		const oldest = samples[0]!;
		const elapsed = (now - oldest.time) / 1000;
		const bytesInWindow = raw.downloadedBytes - oldest.bytes;
		const speedBps = elapsed > 0 ? bytesInWindow / elapsed : 0;

		const percent = Math.round((raw.downloadedBytes / raw.totalBytes) * 100);
		const dlMB = (raw.downloadedBytes / (1024 * 1024)).toFixed(0);
		const totalMB = (raw.totalBytes / (1024 * 1024)).toFixed(0);
		const speedMB = (speedBps / (1024 * 1024)).toFixed(1);

		const remaining = speedBps > 0 ? (raw.totalBytes - raw.downloadedBytes) / speedBps : 0;
		let eta: string;
		if (speedBps === 0 || !Number.isFinite(remaining)) {
			eta = "calculating…";
		} else if (remaining > 60) {
			eta = `~${Math.floor(remaining / 60)}m ${Math.round(remaining % 60)}s left`;
		} else {
			eta = `~${Math.round(remaining)}s left`;
		}

		const sizeLabel = `${dlMB} / ${totalMB} MB`;
		const speed = `${speedMB} MB/s`;
		const fileProgress = `${raw.fileIndex + 1}/${raw.totalFiles}`;

		const line = `Downloading ${modelName}… ${percent}% (${sizeLabel}) · ${speed} · ${eta}`;

		return { percent, sizeLabel, speed, eta, line, file: raw.file, fileProgress };
	};
}

// ─── Post-download verification ──────────────────────────────────────────────

/**
 * Verify a downloaded model is complete and usable.
 * Checks that all expected files exist and have non-zero size.
 */
export function verifyDownload(
	modelId: string,
	downloadUrls: Record<string, string>,
	expectedTotalBytes: number
): { ok: boolean; issues: string[] } {
	const issues: string[] = [];
	const dir = getModelDir(modelId);

	if (!fs.existsSync(dir)) {
		issues.push(`Model directory not found: ${dir}`);
		return { ok: false, issues };
	}

	let totalSize = 0;
	for (const [role, url] of Object.entries(downloadUrls)) {
		const filename = fileNameFromUrl(url);
		const filePath = path.join(dir, filename);

		if (!fs.existsSync(filePath)) {
			issues.push(`Missing file: ${filename} (${role})`);
			continue;
		}

		const stat = fs.statSync(filePath);
		if (stat.size === 0) {
			issues.push(`Empty file: ${filename} (${role}) — may be corrupted`);
			continue;
		}

		// Check for leftover .tmp files (incomplete download)
		if (fs.existsSync(filePath + ".tmp")) {
			issues.push(`Incomplete download detected: ${filename}.tmp — delete and retry`);
		}

		totalSize += stat.size;
	}

	// Sanity check: total should be within 10% of expected
	if (issues.length === 0 && expectedTotalBytes > 0) {
		const ratio = totalSize / expectedTotalBytes;
		if (ratio < 0.5) {
			issues.push(
				`Download appears incomplete: ${Math.round(totalSize / (1024 * 1024))} MB downloaded, expected ~${Math.round(expectedTotalBytes / (1024 * 1024))} MB`
			);
		}
	}

	return { ok: issues.length === 0, issues };
}

// ─── Handy model import ──────────────────────────────────────────────────────

/** Known Handy model directory (macOS) */
const HANDY_MODELS_DIR = path.join(os.homedir(), "Library", "Application Support", "com.pais.handy", "models");

/** Map of handy model directory names → pi model IDs + file mappings */
const HANDY_MODEL_MAP: Record<
	string,
	{
		piModelId: string;
		/** Map of handy filename → pi expected filename */
		fileMap: Record<string, string>;
	}
> = {
	"parakeet-tdt-0.6b-v3-int8": {
		piModelId: "parakeet-v3",
		fileMap: {
			"encoder-model.int8.onnx": "encoder.int8.onnx",
			"decoder_joint-model.int8.onnx": "decoder.int8.onnx",
			"nemo128.onnx": "joiner.int8.onnx",
			"vocab.txt": "tokens.txt",
		},
	},
};

export interface HandyModel {
	handyId: string;
	piModelId: string;
	name: string;
	sizeMB: number;
	imported: boolean;
}

/**
 * Scan Handy's model directory for compatible models that can be imported.
 * Returns models found in Handy that have a known mapping to pi model format.
 */
export function scanHandyModels(): HandyModel[] {
	if (!fs.existsSync(HANDY_MODELS_DIR)) return [];

	const results: HandyModel[] = [];
	try {
		const entries = fs.readdirSync(HANDY_MODELS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const mapping = HANDY_MODEL_MAP[entry.name];
			if (!mapping) continue;

			const handyDir = path.join(HANDY_MODELS_DIR, entry.name);
			const sizeMB = getDirSizeMB(handyDir);
			const piDir = getModelDir(mapping.piModelId);
			const imported = fs.existsSync(piDir) && isSymlinkOrComplete(piDir, mapping);

			results.push({
				handyId: entry.name,
				piModelId: mapping.piModelId,
				name: entry.name,
				sizeMB,
				imported,
			});
		}
	} catch {
		// Permission error or directory not accessible
	}
	return results;
}

/**
 * Import a Handy model by creating symlinks from pi's model directory
 * to Handy's files with the correct filenames.
 * Avoids duplicating large model files on disk.
 */
export function importHandyModel(handyId: string): { ok: boolean; error?: string } {
	const mapping = HANDY_MODEL_MAP[handyId];
	if (!mapping) return { ok: false, error: `Unknown Handy model: ${handyId}` };

	const handyDir = path.join(HANDY_MODELS_DIR, handyId);
	if (!fs.existsSync(handyDir)) return { ok: false, error: `Handy model not found: ${handyDir}` };

	const piDir = getModelDir(mapping.piModelId);
	fs.mkdirSync(piDir, { recursive: true });

	for (const [handyFile, piFile] of Object.entries(mapping.fileMap)) {
		const src = path.join(handyDir, handyFile);
		const dest = path.join(piDir, piFile);

		if (!fs.existsSync(src)) {
			return { ok: false, error: `Missing file in Handy: ${handyFile}` };
		}

		// Skip if already exists (real file or valid symlink)
		if (fs.existsSync(dest)) continue;

		try {
			fs.symlinkSync(src, dest);
		} catch (err: any) {
			// Symlink failed — try copying instead (e.g., cross-device)
			try {
				fs.copyFileSync(src, dest);
			} catch (copyErr: any) {
				return { ok: false, error: `Failed to link/copy ${handyFile}: ${copyErr.message}` };
			}
		}
	}

	return { ok: true };
}

/** Check if a pi model dir has valid symlinks or files for a handy mapping */
function isSymlinkOrComplete(piDir: string, mapping: { fileMap: Record<string, string> }): boolean {
	for (const piFile of Object.values(mapping.fileMap)) {
		if (!fs.existsSync(path.join(piDir, piFile))) return false;
	}
	return true;
}

// ─── Disk space ──────────────────────────────────────────────────────────────

/** Get free disk space in bytes for the given path. Returns null if unavailable. */
export function getFreeDiskSpace(dirPath: string): number | null {
	try {
		// Node 18.15+ / Bun — statfsSync
		const stats = fs.statfsSync(dirPath);
		return stats.bavail * stats.bsize;
	} catch {
		// statfsSync not available or path doesn't exist yet
	}

	// Fallback: try parent directory
	const parent = path.dirname(dirPath);
	if (parent !== dirPath) {
		try {
			const stats = fs.statfsSync(parent);
			return stats.bavail * stats.bsize;
		} catch {
			// Give up
		}
	}

	return null;
}

/** Format bytes as human-readable string. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract filename from a URL. */
function fileNameFromUrl(url: string): string {
	const urlPath = new URL(url).pathname;
	return path.basename(urlPath);
}

/** Get total size of a directory in bytes. */
function getDirSizeBytes(dirPath: string): number {
	let total = 0;
	try {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name);
			if (entry.isFile()) {
				total += fs.statSync(fullPath).size;
			} else if (entry.isDirectory()) {
				total += getDirSizeBytes(fullPath);
			}
		}
	} catch {
		// Permission error
	}
	return total;
}

/** Get total size of a directory in MB. */
function getDirSizeMB(dirPath: string): number {
	return Math.round(getDirSizeBytes(dirPath) / (1024 * 1024));
}
