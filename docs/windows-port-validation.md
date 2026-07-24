# Windows port: current state and remaining validation

This document records what the **first Windows-port milestone** implements, what
it deliberately proves, and - crucially - what it does **not** claim to prove.
The remaining proofs require a clean, packaged Windows environment that this
milestone's CI does not exercise. Treat anything below marked "needs
clean-Windows validation" as **not yet shipped for Windows**, even though the
host-side plumbing is in place.

## What this milestone implements and validates automatically

All of the following are covered by automated tests. The `windows-latest` job in
`.github/workflows/ci.yml` runs these platform-portable suites on a Windows host:

1. **Platform-safe PATH handling** (`src/main/shell-path.ts`)
   - `mergeShellPath` no longer appends Unix directories or a `:` delimiter on
     Windows; it returns the inherited PATH unchanged (Windows already inherits
     the merged system+user PATH from the registry). Regression test in
     `tests/shell-path.test.ts` covers the final-entry-corruption defect,
     multiple drive letters, and preserved POSIX behavior.

2. **Child-scoped Electron-as-Node adapter launcher**
   (`src/main/windows-adapter-launcher.ts`, `src/main/app.ts`)
   - On Windows, the acpx override starts the bundled Electron executable in a
     dedicated Baby Menu launcher mode. That mode applies
     `ELECTRON_RUN_AS_NODE=1` only to the adapter child, starts the same Electron
     executable with the bundled `.mjs`, inherits all three ACP stdio handles,
     and exits with the adapter's status.
   - Source/dev commands include the Electron app path needed to enter the same
     launcher mode. Packaged commands launch the installed executable directly.
     `tests/launch-command.test.ts` proves both built-in agents carry the
     launcher, scoped environment, and exact adapter path.

3. **Correctly-quoted bundled-adapter launch path** (`src/main/launch-command.ts`)
   - `quoteLaunchToken` / `joinLaunchCommand` build a launch-command string that
     round-trips through acpx's own `splitCommandLine` parser for Windows
     install paths containing spaces, backslashes, `&`, parentheses, and
     non-ASCII text. Backslashes are normalized to forward slashes
     (parser-safe and Windows-usable by `spawn`/`fs`/acpx).
   - `splitAcpxCommand` is a faithful port of the pinned acpx parser, exported
     so tests prove the constructed string reparses into the exact intended
     tokens - without needing a Windows host. Covered by
     `tests/launch-command.test.ts`, including the confirmed backslash-stripping
     defect as a regression anchor.

4. **Prompt delivery outside shell-parsed argv**
   (`src/adapters/claude/driver.ts`, `src/adapters/codex/driver.ts`)
   - Both drivers omit the user prompt from positional arguments and write it
     verbatim to the CLI's stdin before closing the stream. Prompts containing
     cmd.exe metacharacters, percent signs, newlines, and quotes therefore never
     enter the `.cmd` shell command.
   - Cross-platform fake-CLI regressions prove verbatim delivery, absence from
     argv, and that an attempted extra command does not create its sentinel.

5. **PATHEXT / `.cmd`-aware native agent launching** (`src/adapters/shared/platform-spawn.ts`)
   - `resolveDriverCommand` resolves a bare command to its `.cmd` shim via
     PATHEXT and PATH search (mirrors acpx's own resolution); `driverSpawnOptions`
     sets `shell: true` for `.cmd`/`.bat` shims so Node can launch them. Both
     drivers (`claude`, `codex`) now resolve and spawn through these helpers.
     Covered by `tests/platform-spawn.test.ts`.

6. **Bounded Windows process-tree cancellation** (`src/adapters/shared/process-tree.ts`)
   - `createChildTerminator` keeps the exact POSIX `SIGTERM` -> `SIGKILL` behavior
     and, on Windows, runs `taskkill /T /F /PID <pid>` with a numeric pid (no
     shell interpolation of untrusted text). Each call has a five-second timeout,
     and cancellation makes at most two attempts. After a failed first attempt,
     the terminator does not separately kill the immediate child, so the forced
     attempt can retry the tree while that PID remains available. If both attempts
     fail or time out, it force-kills the immediate child. Both drivers cancel and
     dispose through the terminator. Covered by `tests/process-tree.test.ts`.

7. **`pnpm.cmd`-safe dev launcher** (`scripts/dev.mjs`)
   - Package-manager invocations run through `shell: true` so `pnpm.cmd` resolves
     on Windows. Covered by `tests/dev-launcher.test.ts`.

8. **Windows CI** (`.github/workflows/ci.yml`, `windows` job)
   - Runs `pnpm typecheck`, `pnpm build`, the five platform unit files, and both
     stdin prompt regressions on `windows-latest`.

## What this milestone does NOT prove (needs clean-Windows validation)

These items require a real, packaged Windows runtime and are the documented
remaining steps for the full port. The spike intentionally does not pretend they
passed.

### A. Packaged Electron-as-Node launcher behavior

The launcher and its acpx command wiring are implemented and covered by
cross-platform unit tests. A real packaged runtime is still needed to validate
the Electron/Windows process boundary rather than only the host-side contract.

**Remaining clean-Windows validation step:**
1. On a clean Windows 11 x64 VM, build a temporary packaged Electron app under a
   `C:\Program Files\...` path with spaces/non-ASCII, and prove
   Electron-as-Node launches both bundled ACP adapters with the env scoped to
   each child and ACP stdout uncontaminated.
2. Confirm the launcher exits with each adapter's status and leaves no
   intermediate launcher process after a normal ACP shutdown.

Do not claim the Windows adapter launch works until this passes on a real
packaged install. Setting `ELECTRON_RUN_AS_NODE` globally in the Electron main
process was considered and rejected as too broad: it would propagate to every
host child (git, taskkill probes, background-task shells) even though most ignore
it, and it could not be validated here.

### B. Real `.cmd` cancellation leaves zero descendants

`taskkill /T /F /PID <pid>` is the correct, bounded tree kill, but its
effectiveness against a real `claude.cmd`/`codex.cmd` shim and the CLI's tool
children must be observed on Windows.

**Remaining clean-Windows validation step:**
1. On the clean VM, drive one real prompt through each adapter and cancel/timeout
   it mid-turn.
2. Assert no `claude*`, `codex*`, `node`, or tool-process descendant survives
   (e.g. via `tasklist` after the turn settles).

### C. The broader test suite on Windows

The `windows` CI job intentionally runs only the platform-portable unit files
and prompt transport regressions. Many other specs execute `/bin/bash`/`/bin/sh`, rely on Unix fixtures
(shebangs, `chmod`, symlinks), or are explicitly `skipIf(win32)`. Porting the
core ACP/change-session e2e to Windows (removing the win32 skips in
`tests/e2e-acp-runtime.test.ts`) is not done here.

### D. Out of scope for this milestone entirely

None of the following are in this milestone: tray polish/assets,
`.ico`, AppUserModelID, single-instance lock, NSIS installer, Authenticode
signing, update copy, recipe platform-filtering/parity, or any greenfield
rewrite.
