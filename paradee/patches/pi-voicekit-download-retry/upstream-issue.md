# Issue draft — CyFeng16/pi-voicekit

**Title:** Model downloads abort on transient connection resets ("fetch failed") — add Range-resume retry loop

**Version:** 0.4.2 (latest on npm as of 2026-10-17), Windows 11, Node 24.21.0

## Symptom

`/voice-settings` → download *Parakeet TDT v3 (~671 MB)*:

```
Starting download: Parakeet TDT v3 (~671 MB)…
Download failed: Parakeet TDT v3
Error: fetch failed

Partial downloads are auto-resumed on next attempt.
```

Nothing is written to `~/.pi/models/parakeet-v3/`, and retrying usually fails the same way.
The message is useless for diagnosis: `voice.ts` prints `err.message` only, and undici's
message for every connection-level failure is the string `fetch failed`.

## Diagnosis

The model host resets TLS connections intermittently on some networks. Same failure from
two independent clients:

```
$ curl …/resolve/main/joiner.int8.onnx
curl: (35) Recv failure: Connection was reset          # ~1 in 3 attempts

node: TypeError: fetch failed
        cause: Error: ECONNRESET  read ECONNRESET
```

`downloadModel()` in `extensions/voice/model-download.ts` already has Range resume
(`.tmp` + `Range: bytes=N-`), but it has **no retry**: a single reset — before the first
byte, or 500 MB in — propagates out of `ensureModelDownloaded()` and the install dies.
`checkDownloadPrereqs()` is even more fragile: it issues one HEAD request, so a single
reset blocks the download before it starts (reported as `Network error: fetch failed`).

A 670 MB single-shot transfer needs ~10 resets' worth of tolerance on such links; the
resume machinery is present but unreachable.

## Fix (locally verified)

Wrap the per-file fetch/stream in a bounded retry loop that re-derives the Range start
from the `.tmp` size, and unwrap the cause chain for the UI:

```ts
const RETRYABLE_CODES = new Set(["ECONNRESET","ECONNREFUSED","ECONNABORTED","ETIMEDOUT","EPIPE",
  "ENOTFOUND","EAI_AGAIN","EHOSTUNREACH","ENETUNREACH","UND_ERR_SOCKET","UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT","UND_ERR_BODY_TIMEOUT"]);

export function isRetryableNetworkError(err: unknown): boolean {
  let cursor: any = err, depth = 0;
  while (cursor && depth++ < 6) {
    if (cursor.name === "AbortError" || cursor.name === "TimeoutError") return false; // user abort
    if (typeof cursor.code === "string" && RETRYABLE_CODES.has(cursor.code)) return true;
    if (typeof cursor.message === "string" && /socket hang up|other side closed|terminated\b|fetch failed/i.test(cursor.message)) return true;
    cursor = cursor.cause;
  }
  return false;
}

/** Flatten the cause chain: "fetch failed — read ECONNRESET (ECONNRESET)" */
export function describeError(err: unknown): string { /* walk err.cause, dedupe, join with " — " */ }

// in downloadModel(), per file:
for (let attempt = 1; ; attempt++) {
  const startByte = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
  let overallDownloaded = bytesCommitted + startByte;      // resumed bytes never double-counted
  try {
    const resp = await fetch(url, { headers: startByte ? { Range: `bytes=${startByte}-` } : {}, signal, redirect: "follow" });
    /* …existing stream-to-.tmp loop, unchanged… */
    fs.renameSync(tmpPath, filePath);
    bytesCommitted += fs.statSync(filePath).size;
    break;
  } catch (err) {
    if (signal?.aborted || attempt >= 8 || !isRetryableNetworkError(err)) {
      if (err instanceof Error) { const d = describeError(err); if (d && d !== err.message) throw new Error(`${err.message} — ${d}`); }
      throw err;
    }
    const retryInMs = Math.min(1000 * attempt, 5000);
    onRetry?.({ file: filename, attempt, maxAttempts: 8, error: describeError(err), resumeAt: /* .tmp size */, retryInMs });
    await sleep(retryInMs, signal);
  }
}
```

Plus:
- `checkDownloadPrereqs()`: 3 attempts on the HEAD, and treat only HTTP ≥ 400 as an issue.
- `voice.ts`: pass an `onRetry` callback to `ensureModelDownloaded` so the user sees
  `Model server dropped the connection — resuming encoder.int8.onnx at 412 MB (attempt 3/8)…`
  instead of a stalled progress bar, and show `describeError(err)` in the failure card.

Disk write failures (ENOSPC/EACCES) stay fatal and must not be retried or renamed over —
keep the `writeStream` error visible (capture it in the `finally`, rethrow before rename).

## Verification

Self-test: local `http.Server` serving a 2 MiB body with `Content-Length` declared, calling
`res.socket.resetAndDestroy()` after 35 % of the body on attempt 1 and after 70 % of the
resumed range on attempt 2:

```
attempts=3 retries=2 (734003B@1000ms, 1688207B@2000ms)
requests: [{"range":null},{"range":"bytes=734003-"},{"range":"bytes=1688207-"}]
final=2097152 expected=2097152 bytesEqual=true tmpLeft=false progress=2097152/2097152
```

Real-world effect: the four Parakeet v3 files (652 MB + 12 MB + 6 MB + 94 KB) completed in
~14 s after 4 resets, and the model then loads and transcribes correctly (sherpa-onnx-node
1.13.8, recognizer load 3.1 s, RTF 0.55).
