# pi-voicekit tar-extract patch (Windows `.tar.bz2` installs hang at “Extracting…”)

Applied to the installed pi-voicekit **0.4.2** (`~/.pi/agent/npm/node_modules/pi-voicekit`) on 2026-10-17.
This patch is independent of, and complements, `../pi-voicekit-download-retry/`.

## Symptom
`/voice-settings` → Models → install **Kitten Nano v0.2**: bar freezes at
`Kitten Nano v0.2 · Extracting… (0 B/64.3 MB, 0.0 MB/s)` forever (observed 50 minutes; nothing in
`~/.pi/models/tts/`, the `.staging-<pid>` dir stays empty). Ctrl+C is ignored while a child process runs.

## Root cause (reproduced, not guessed)
`ensureTtsModelInstalled()` extracts with `spawn("tar", ["-xj", "-f", archive, "-C", stagingDir])`.

1. On Windows that resolves to **`C:\Windows\System32\tar.exe` (bsdtar)** no matter which shell pi runs
   from — `CreateProcess` searches System32 before `PATH`, so Git Bash's GNU tar never wins a bare `spawn("tar")`.
2. Windows bsdtar has **no internal bzip2**: `-j` is the external filter program `bzip2 -d`.
   Proof (PATH stripped to System32 only): `tar.exe: Error opening archive: Can't initialize filter; unable to run program "bzip2 -d"`.
3. When a Git Bash / MSYS2 `bzip2.exe` *is* on `PATH`, bsdtar launches it and the pipe **deadlocks**:
   the wedged process showed `ReadTransferCount 141,559` / `WriteTransferCount 65,536` (one 64 KiB pipe buffer),
   `UserModeTime + KernelModeTime ≈ 0.09 s` of CPU and no growth over 5 minutes.
4. Control run in the self-test: System32 `tar.exe -xj` on the real 64 MB kitten archive → no exit within 20 s,
   0 entries written. GNU tar on the same archive: 1.9 s, byte-exact.

So local TTS/Piper/Kokoro installs are **environment roulette** on Windows, and when they fail they hang forever.

## What the patch changes (`extensions/voice/tts-local-models.ts`)
- `resolveTar()` — on win32, scan `PATH` for a **GNU tar** (`tar --version` matches `GNU tar`, i.e. internal bzip2),
  skipping `%SystemRoot%\System32\tar.exe`, and spawn it by absolute path. Cached in `cachedTar`.
- Relative arguments + `cwd` — the archive (`<modelId>.partial.tar.bz2`) and the staging dir
  (`<modelId>.staging-<pid>`) both live directly in `getTtsModelsDir()`, so tar gets
  `-xj -f <name> -C <name>` with `cwd` there (forward slashes). Required because MSYS tar parses an
  absolute `C:/…` argument with its remote-archive syntax `[user@]host:file` and dies with
  `Cannot connect to C: resolve failed`.
- `EXTRACT_STALL_MS = 60_000` watchdog — `extractStalled(dir, startedAt, now)` compares `max(mtime)` of the
  staging dir entries against `startedAt`; if nothing was written for 60 s the child is `SIGKILL`ed and the
  install fails with a real error (with a Windows hint + the manual `curl … | tar xj` command) instead of hanging.
- Exports `resolveTar` / `extractStalled` / `runTarExtract` so the self-test can reach them.

## Files
- `tar-extract.patch` — unified diff, stock 0.4.2 → patched (158 lines).
- `orig/tts-local-models.ts` — stock 0.4.2 (md5 `3e45c955970a10dc20ad7b134d6570f6`).
- `fixed/tts-local-models.ts` — patched copy the diff was generated from.
- `apply.sh` — idempotent re-apply (skips when `resolveTar` already present), `patch`, Node
  `stripTypeScriptTypes` parse check, then runs the self-test.
- `test_extract.mjs` — self-test: tar selection, `extractStalled` semantics, the bsdtar control
  (deadlock reproduced), and a byte-exact 8 MiB extract through `runTarExtract`.
  `KTN_TAR_ARCHIVE=<path to a real .tar.bz2>` makes the control use a real-size archive.

## Re-applying after a pi-voicekit version bump (pi-auto-update wipes node_modules patches)
```
bash ~/.pi/agent/patches/pi-voicekit-tar-extract/apply.sh
```
Round-trip proven: installed file reverted to stock → `apply.sh` → patched → `EXTRACT SELFTEST OK`.
If upstream fixes this, the file will contain `resolveTar` and the script does nothing; hand-check the
upstream diff against `fixed/tts-local-models.ts` before assuming it is equivalent.

## Manual workaround (no patch)
Extract the archive yourself — GNU tar from Git Bash has internal bzip2:
```
curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_2-fp16.tar.bz2 | tar xj -C ~/.pi/models/tts
```
The extension treats `~/.pi/models/tts/<modelId>/tokens.txt` as the install marker.
