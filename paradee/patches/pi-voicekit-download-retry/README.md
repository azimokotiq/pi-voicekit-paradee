# pi-voicekit download-retry patch

**Why:** huggingface.co intermittently RSTs TLS connections on this machine
(`curl: (35) Recv failure: Connection was reset`; Node: `TypeError: fetch failed` with
cause `ECONNRESET read ECONNRESET`; ~15–50 % of attempts, both curl and Node).
Stock pi-voicekit 0.4.2 treats any transport error as fatal, so one reset aborted the
671 MB Parakeet TDT v3 install with the opaque message `Error: fetch failed`
(`model-download.ts downloadModel()` had Range-resume but no retry; `voice.ts` printed
only `err.message`, never `err.cause.code`).

**What changes** (`extensions/voice/model-download.ts` + the download card in `voice.ts`):
- `isRetryableNetworkError(err)` — walks `err.cause`, never retries `AbortError`/`TimeoutError`.
- `describeError(err)` — flattens the cause chain: `fetch failed — read ECONNRESET (ECONNRESET)`.
- `downloadModel()` now loops **≤8 attempts per file**, each attempt recomputing the Range
  start from the `.tmp` size, with `min(1000·attempt, 5000)` ms backoff. Progress accounting is
  derived from committed-bytes + current `.tmp` size, so resumed bytes are never double counted.
  Write errors (ENOSPC/EACCES) are still fatal and never renamed over.
- `ensureModelDownloaded(...)` takes a new trailing optional `onRetry` callback; `voice.ts` uses
  it to show `Model server dropped the connection — resuming encoder.int8.onnx at 412 MB (attempt 3/8)…`
  instead of looking hung, and the failure card now shows the real cause.
- `checkDownloadPrereqs()` retries its HEAD 3× (it used to fail the whole install on one reset)
  and only reports HTTP ≥400.

**Files**
- `orig/` — stock 0.4.2 copies (md5 `5f914fb7…` model-download.ts, `02fd2790…` voice.ts)
- `patched/` — patched copies as installed
- `model-download.retry.patch`, `voice.retry.patch` — unified diffs
- `apply.sh` — re-applies after an update (`patch` + Node type-strip parse check + self-test)
- `test_retry.mjs` — self-test: local HTTP server RSTs the socket at 35 % and 70 % of the body;
  asserts the file lands byte-exact via Range-resume, ≥2 retries fired, no `.tmp` left behind.
  → `RETRY SELFTEST OK`
- `upstream-issue.md` — paste-ready issue for https://github.com/CyFeng16/pi-voicekit

**State:** applied to `~/.pi/agent/npm/node_modules/pi-voicekit` (0.4.2 = latest on npm as of
2026-10-17). `pi-auto-update` will overwrite it on the next bump — re-run `apply.sh` then.
