# Local model install hangs forever at “Extracting…” on Windows (`tar -xj` deadlocks)

pi-voicekit 0.4.2, Windows 11, pi run from Git Bash. Installing **Kitten Nano v0.2** (64.3 MB) from
`/voice-settings` → Models froze at `Kitten Nano v0.2 · Extracting… (0 B/64.3 MB, 0.0 MB/s)` for 50 minutes;
the process had to be killed (`taskkill /F /IM tar.exe`), which let the extension's catch clean up.

## Root cause

`runTarExtract()` spawns `tar -xj -f <archive> -C <staging>`:

1. On Windows `spawn("tar")` always resolves to **`C:\Windows\System32\tar.exe` (bsdtar)** — `CreateProcess`
   searches System32 before `PATH`, so Git Bash's GNU tar is never picked even inside Git Bash.
2. Windows bsdtar is built **without internal bzip2**; `-j` runs the external filter `bzip2 -d`.
   With `PATH` reduced to System32 the same command fails fast and proves it:
   `tar.exe: Error opening archive: Can't initialize filter; unable to run program "bzip2 -d"`
3. When an MSYS2/Git-Bash `bzip2.exe` is on `PATH` (very common — pi is usually launched from Git Bash),
   bsdtar starts that child and the pipe **deadlocks** after one 64 KiB buffer. The wedged tar reported
   `ReadTransferCount 141,559`, `WriteTransferCount 65,536`, ~0.09 s total CPU and zero growth across
   repeated samples. Same archive, GNU tar (`/usr/bin/tar`): 1.9 s, byte-exact.

Net effect: on Windows, `.tar.bz2` model installs work or wedge depending on which `bzip2` happens to be on
`PATH` — and when they fail, they hang instead of erroring.

Reproduction of the deadlock (System32 tar, bzip2 on PATH):

```
$ /c/Windows/System32/tar.exe -xj -f kitten.tar.bz2 -C out   # 90 s timeout, 0 entries written,
                                                            # "Child process exited with status 143" on kill
```

## Proposed fix (what I run locally, verified by a self-test)

```ts
// 1. Prefer a tar with internal bzip2 (GNU tar); Windows' bsdtar cannot do -j on its own.
let cachedTar: string | null | undefined;
function isGnuTar(bin: string): boolean {
  try { return /GNU tar/i.test(spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 }).stdout ?? ""); }
  catch { return false; }
}
function resolveTar(): string {
  if (cachedTar !== undefined) return cachedTar ?? "tar";
  let chosen: string | null = null;
  if (process.platform === "win32") {
    const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe").toLowerCase();
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      const cand = path.join(dir, "tar.exe");
      if (!cand.toLowerCase().startsWith(system) && fs.existsSync(cand) && isGnuTar(cand)) { chosen = cand; break; }
    }
  }
  cachedTar = chosen;
  return chosen ?? "tar";
}

// 2. Pass archive + staging as names relative to getTtsModelsDir() with cwd set there: both already
//    live there (`<id>.partial.tar.bz2`, `<id>.staging-<pid>`), and MSYS tar reads an absolute `C:/…`
//    argument as its remote-archive syntax `[user@]host:file`
//    ("Cannot connect to C: resolve failed"), which would otherwise make GNU tar unusable.

// 3. Never hang: kill the child if nothing is written to the staging dir for 60 s and report a
//    runnable command instead (curl -L <archiveUrl> | tar xj -C "<getTtsModelsDir()>").
const EXTRACT_STALL_MS = 60_000;
function extractStalled(dir: string, startedAtMs: number, nowMs: number, stallMs = EXTRACT_STALL_MS): boolean {
  let newest = startedAtMs;
  try {
    for (const name of fs.readdirSync(dir)) {
      try { newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs); } catch {}
    }
  } catch { return false; } // dir vanished — the close handler reports the real error
  return nowMs - newest >= stallMs;
}
```

Verified with an 8 MiB `tar.bz2` fixture inside `~/.pi/models/tts`: bsdtar control deadlocks (no exit in
20 s, 0 entries), `runTarExtract` extracts byte-exact in 1.9 s; `extractStalled` returns stall after 61 idle
seconds, clears on a fresh write, and does not trip during the 1 s startup grace.

Alternative/addition: ship `.tar.zst` or `.zip` archives, or extract in-process — both remove the
external-`bzip2` dependency entirely.

## Workaround that works today

```
curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_2-fp16.tar.bz2 | tar xj -C ~/.pi/models/tts
```

`isTtsModelInstalled()` only checks `<modelDir>/tokens.txt`, so a manual extract is recognised.
