# Windows port: current state and remaining validation

This document records what the **first Windows-port milestone** implements, what
it deliberately proves, and - crucially - what it does **not** claim to prove.
Treat anything below marked "needs clean-Windows validation" as **not yet
shipped for Windows**, even though the host-side plumbing is in place.

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
   - Launcher shutdown forwards through the bounded Windows tree terminator. The
     adapter also watches the launcher PID and disposes its CLI tree if forced
     outer-process termination prevents Electron cleanup from running.

3. **Correctly-quoted bundled-adapter launch path** (`src/main/launch-command.ts`)
   - `quoteLaunchToken` / `joinLaunchCommand` build a launch-command string that
     round-trips through acpx's own `splitCommandLine` parser for Windows
     install paths containing spaces, backslashes, `&`, parentheses, and
     non-ASCII text. Backslashes are normalized to forward slashes
     (parser-safe and Windows-usable by `spawn`/`fs`/acpx).
   - `splitAcpxCommand` is a faithful port of the pinned acpx parser, exported
     so tests prove the constructed string reparses into the intended,
     slash-normalized tokens - without needing a Windows host. Covered by
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
     PATHEXT and PATH search (mirrors acpx's own resolution).
     `resolveDriverSpawn` carries `.cmd`/`.bat` paths through a child-scoped
     environment value and invokes a fixed, independently quoted cmd.exe token
     before enabling `shell: true` with `windowsHide: true`. Paths with spaces,
     percent expansions, and shell metacharacters never become raw command text.
     Both drivers resolve and spawn through the same helper. Covered by
     `tests/platform-spawn.test.ts`.

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

8. **Windows package native dependencies** (`pnpm-workspace.yaml`,
   `tests/windows-packaging.test.ts`)
   - The dependency install retains the `win32` optional packages required by a
     Windows build, including `lightningcss-win32-x64-msvc`.
   - Windows CI builds an x64 `win-unpacked` package and asserts that
     `lightningcss.win32-x64-msvc.node` is inside the packaged
     `resources/app.asar.unpacked` tree.

9. **Windows CI** (`.github/workflows/ci.yml`, `windows` job)
   - Runs `pnpm typecheck`, `pnpm build`, the five platform unit files, both
     stdin prompt regressions, and the package-content assertion on
     `windows-latest`.

## Manual Windows 11 validation (2026-07-24)

A focused manual check ran on Windows 11 Home x64 (build 26200) through the
host's WSL interop. The unsigned x64 `win-unpacked` app used Electron 42.2.0
(Electron-as-Node reported Node 24.15.0). The package and every test artifact
stayed in the disposable worktree; Windows accessed it through
`\\wsl.localhost\Ubuntu\...`, temporarily mapped to a drive by `pushd`.

The difficult-path fixtures were `Windows Package 测试 & (x64)` for the app and
`Agent Bin & (测试)` for `codex.cmd`. The host had no native Windows Node or agent
installation, so the project-local `.cmd` fixture delegated to the real,
already-authenticated Codex CLI 0.145.0 in WSL. Authentication and runtime state
were copied into the ignored worktree evidence directory for the check; no
credential value or raw provider response was captured.

The first GUI package was assembled from a Linux dependency tree that omitted
the optional `lightningcss-win32-x64-msvc` package. It crashed before Baby
Menu's main process reached the adapter launcher because the main import chain
loads `@tailwindcss/postcss` and `lightningcss`. Reinstalling with the Windows
optional dependency and repackaging removed that startup failure. The committed
`supportedArchitectures` configuration now retains `win32` dependencies, and
Windows CI guards the packaged binary itself rather than only the install tree.

The following checks then passed against the unpacked production artifacts:

1. The packaged GUI started on Windows and reached Baby Menu's main process.
2. Running the packaged executable with `ELECTRON_RUN_AS_NODE=1` reported
   `win32`, Node 24.15.0, and Electron 42.2.0.
3. The unpacked `out/adapters/codex/index.mjs` completed an ACP protocol-v1
   initialize/new-session/prompt exchange through that executable and the real
   `.cmd` boundary.
4. A four-line prompt containing `& | < > ^ %`, quotes, parentheses, and a
   command-shaped redirection string returned exactly `WINDOWS_PROMPT_OK`,
   stopped with `end_turn`, and did not create the injection sentinel.
5. The CLI fixture recorded `ELECTRON_RUN_AS_NODE` as unset, proving the adapter
   removed the child-only Electron mode before starting the real CLI.
6. A second turn started a real `sleep 120` descendant, then received
   `session/cancel`. The turn stopped as `cancelled`; the observed WSL
   Node/Codex/sleep processes and Windows `wsl.exe` chain were all gone after
   cancellation, and the adapter exited 0. The normal completed turn also left
   no marked Windows or WSL process.

This directly validates packaged GUI startup, the packaged Electron-as-Node
child, difficult-path `.cmd` execution, prompt transport, and Windows tree
cancellation.

### Outer-launcher follow-up (2026-07-25)

The first complete ACP exchange through
`--baby-menu-electron-node-launcher` reproduced exit code 3 before initialize.
The failure was not in ACP or adapter spawning: Chromium repeatedly failed to
start its GPU process because the unpacked Electron app was running from the
WSL network share, then terminated the outer process as unusable. Direct
Electron-as-Node execution never starts Chromium and therefore masked that
outer-process failure.

The dedicated no-renderer launcher now disables hardware acceleration and keeps
the disabled GPU fallback in that trusted outer process. The normal GUI process
is unchanged, and the workaround does not use `--no-sandbox` or disable the
normal GUI sandbox.

After rebuilding the same unpacked package, the outer launcher completed a real
Codex ACP initialize/new-session/prompt exchange through the difficult-path
`.cmd` fixture. The multiline metacharacter prompt arrived verbatim over stdin,
did not appear in Windows process argv, did not create the injection sentinel,
and returned exactly `WINDOWS_PROMPT_OK`. A second outer-launcher run started a
real marked `sleep 120` tool descendant, returned `cancelled` after
`session/cancel`, and left no marked Windows, WSL, Codex, or sleep process.

This follow-up does not claim installer, signing, native-local-drive, or Claude
validation. Driving both bundled adapters from a short native Windows path
remains a clean-Windows item below.

## What this milestone does NOT prove (needs clean-Windows validation)

These items require a real, packaged Windows runtime and are the documented
remaining steps for the full port. The spike intentionally does not pretend they
passed.

### A. Packaged Electron-as-Node launcher behavior

The launcher and its acpx command wiring are implemented and covered by
cross-platform unit tests. The manual follow-up above validates a complete Codex
ACP exchange, cancellation, and teardown through the outer GUI process from the
WSL network share. It does not validate the equivalent Claude path or a package
copied to a native local drive.

**Remaining clean-Windows validation step:**
1. On a clean Windows 11 x64 VM, place a temporary packaged Electron app under
   a path with spaces/non-ASCII on a short native local drive, and drive both
   bundled adapters through the outer `--baby-menu-electron-node-launcher`
   process over ACP.
2. Confirm the WSL-proven child-env scoping, clean ACP stdout, launcher exit
   propagation, and normal/forced teardown for both native agent installations.

Do not claim both Windows adapter launches work from a native packaged install
until this passes. Setting `ELECTRON_RUN_AS_NODE` globally in the Electron main
process remains rejected as too broad: it would propagate to every host child
(git, taskkill probes, background-task shells) even though most ignore it.

### B. Native Windows agent credentials and `.cmd` cancellation

The manual check above proves `taskkill /T /F /PID <pid>` removes a real
project-local `codex.cmd` process tree, including the authenticated Codex CLI and
a live tool descendant reached through `wsl.exe`. A native Windows agent
installation was not available on this host.

**Remaining clean-Windows validation step:**
1. On the clean VM, drive one real prompt through each natively installed
   supported agent and cancel/timeout it mid-turn.
2. Assert no native `claude*`, `codex*`, `node`, or tool-process descendant
   survives (e.g. via `tasklist` after the turn settles).

### C. The broader test suite on Windows

The `windows` CI job intentionally runs only the platform-portable unit files
and prompt transport regressions. Many other specs execute `/bin/bash`/`/bin/sh`,
rely on Unix fixtures (shebangs, `chmod`, symlinks), or are explicitly
`skipIf(win32)`. Porting the core ACP/change-session e2e to Windows (removing the
win32 skips in `tests/e2e-acp-runtime.test.ts`) is not done here.

### D. Out of scope for this milestone entirely

None of the following are in this milestone: tray polish/assets,
`.ico`, AppUserModelID, single-instance lock, NSIS installer, Authenticode
signing, update copy, recipe platform-filtering/parity, or any greenfield
rewrite.
