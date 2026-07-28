# Windows port: current state and remaining validation

Items marked "needs clean-Windows validation" are **not yet shipped for Windows** even though the host-side plumbing is in place.

## What this milestone implements and validates automatically

All below are covered by automated tests.
Item 10 records the platform-portable subset CI runs on a Windows host.

1. **Platform-safe PATH handling** (`src/main/shell-path.ts`) — `mergeShellPath` returns inherited PATH unchanged on Windows (no Unix delimiter appended).
   `tests/shell-path.test.ts`.

2. **Child-scoped Electron-as-Node adapter launcher** (`src/main/windows-adapter-launcher.ts`, `src/main/app.ts`) — acpx override starts bundled Electron in a dedicated Baby Menu launcher mode (`ELECTRON_RUN_AS_NODE=1` scoped to the adapter child, exiting with the adapter's status).
   `tests/launch-command.test.ts` proves both built-in agents carry the launcher, scoped env, and exact adapter path.
   Launcher shutdown forwards through the bounded Windows tree terminator; the adapter also watches the launcher PID and disposes its CLI tree if forced outer-process termination prevents Electron cleanup.

3. **Correctly-quoted bundled-adapter launch path** (`src/main/launch-command.ts`) — `quoteLaunchToken`/`joinLaunchCommand` builds strings that round-trip through acpx's `splitCommandLine` parser for paths with spaces, backslashes, `&`, parentheses, non-ASCII.
   `splitAcpxCommand` is a faithful port of the pinned acpx parser, exported for cross-platform tests.
   `tests/launch-command.test.ts`.

4. **Prompt delivery outside shell-parsed argv** (`src/adapters/claude/driver.ts`, `src/adapters/codex/driver.ts`) — both drivers write the prompt verbatim to stdin (never positional argv).
   Cross-platform fake-CLI regressions prove verbatim delivery, absence from argv, and that an attempted extra command does not create its sentinel.

5. **PATHEXT / `.cmd`-aware native agent launching** (`src/adapters/shared/platform-spawn.ts`) — `resolveDriverCommand` resolves bare commands via PATHEXT/PATH search (mirrors acpx's own resolution).
   `.cmd`/`.bat` paths invoke cmd.exe directly with `/d /s /c`, scoped `Path` env, `windowsHide`, and `windowsVerbatimArguments`.
   For UNC workspace cwd: starts cmd.exe from a safe local directory, uses `pushd` to map the workspace; fails closed if no safe local launch directory exists.
   `tests/platform-spawn.test.ts`.

6. **UNC-only main-process GPU fallback** (`src/main/app.ts`, `src/shared/paths.ts`) — `isUncWindowsLaunch` checks executable path and cwd before `app.whenReady()`.
   UNC launches disable hardware acceleration and select the disabled in-process GPU fallback.
   Native local-drive launches retain hardware acceleration and GPU sandbox.
   `tests/windows-unc-runtime.test.ts`.

7. **Bounded Windows process-tree cancellation** (`src/adapters/shared/process-tree.ts`) — `createChildTerminator` runs `taskkill /T /F /PID <pid>` (numeric pid, no shell interpolation).
   Five-second timeout, at most two attempts; after a failed first attempt the terminator does not separately kill the immediate child so the forced attempt can retry the living PID.
   If both fail, falls back to force-killing the immediate child.
   `tests/process-tree.test.ts`.

8. **`pnpm.cmd`-safe dev launcher** (`scripts/dev.mjs`) — package-manager invocations use `shell: true`.
   `tests/dev-launcher.test.ts`.

9. **Windows package native dependencies** (`pnpm-workspace.yaml`, `tests/windows-packaging.test.ts`) — `supportedArchitectures` retains `win32` optional packages including `lightningcss-win32-x64-msvc`.
   Windows CI builds an x64 `win-unpacked` package and asserts the packaged `app.asar.unpacked` tree contains `lightningcss.win32-x64-msvc.node`.

10. **Windows CI** (`.github/workflows/ci.yml`, `windows` job) — runs `pnpm typecheck`, `pnpm build`, the five platform unit files, both stdin prompt regressions, and the package-content assertion on `windows-latest`.

## Manual Windows 11 validation (evidence from WSL-interop check)

A focused check ran on Windows 11 Home x64 (build 26200) through WSL interop.
The unsigned x64 `win-unpacked` app used Electron 42.2.0.
Windows accessed the disposable worktree through `\\wsl.localhost\Ubuntu\...`, mapped via `pushd`.
Difficult-path fixtures: `Windows Package 测试 & (x64)` for the app, `Agent Bin & (测试)` for `codex.cmd`.

The initial GUI package omitted `lightningcss-win32-x64-msvc` (Linux dependency tree) and crashed before main process entry because `@tailwindcss/postcss` loads lightningcss.
Reinstalling with the Windows optional dependency fixed it; `supportedArchitectures` now retains `win32` deps, and Windows CI guards the packaged binary.
The following then passed against unpacked production artifacts:

1. Packaged GUI entered main process (UNC fatal GPU crash reproduced later below).
2. `ELECTRON_RUN_AS_NODE=1` reported `win32`, Node 24.15.0, Electron 42.2.0.
3. Unpacked `out/adapters/codex/index.mjs` completed an ACP initialize/new-session/prompt exchange through the real `.cmd` boundary.
4. A four-line prompt with `& | < > ^ %`, quotes, parentheses, and a command-shaped redirection returned exactly `WINDOWS_PROMPT_OK`, stopped with `end_turn`, no injection sentinel.
5. The CLI fixture recorded `ELECTRON_RUN_AS_NODE` as unset (adapter removed child-only Electron mode before starting real CLI).
6. A second turn with a `sleep 120` descendant received `session/cancel` — the turn stopped as `cancelled`.
   Observed WSL Node/Codex/sleep and Windows `wsl.exe` processes gone; adapter exited 0.
   Normal completed turn also left no marked processes.

This validates main-process entry, packaged Electron-as-Node child, difficult-path `.cmd` execution, prompt transport, and Windows tree cancellation.
It does NOT validate stable packaged-GUI startup from a UNC working directory.

### Outer launcher and UNC follow-up

The first ACP exchange through `--baby-menu-electron-node-launcher` reproduced exit code 3 before initialize: Chromium failed to start its GPU process from the WSL network share, terminating the outer process.
The dedicated no-renderer launcher now disables hardware acceleration there (no `--no-sandbox`).
After rebuilding, the outer launcher completed a real Codex ACP exchange through the difficult-path `.cmd` fixture — multiline metacharacter prompt arrived verbatim, no argv injection, no sentinel, `WINDOWS_PROMPT_OK` returned.
A second run with `sleep 120` returned `cancelled` after `session/cancel` with no survivors.

The main GPU crash was reproduced from a UNC cwd three times: sandboxed GPU subprocess failed (error 18), `gpu_data_manager_impl_private.cc:417` ("GPU process isn't usable. Goodbye.").
The main app now applies the disabled in-process GPU fallback before Chromium starts, only when Windows executable path or cwd is UNC.
The adapter drivers pass workspace cwd to the shared spawn helper; UNC `.cmd` launches start cmd.exe from a safe local directory with `pushd`.
Native-drive behavior unchanged.
Cross-platform unit regressions cover both boundaries.
The packaged fix has not been re-run on Windows yet.

This follow-up does not claim installer, signing, native-local-drive, or Claude validation.
Driving both bundled adapters from a short native Windows path remains a clean-Windows item below.

## What this milestone does NOT prove (needs clean-Windows validation)

These require a real, packaged Windows runtime and are the documented remaining steps.

### A. Packaged GUI startup from a UNC working directory

The main-process GPU and `.cmd` cwd safeguards are implemented and covered without launching Electron.

**Remaining packaged-Windows validation step:**
1. From the same UNC setup that reproduced the crash, launch the rebuilt packaged app and confirm it remains live without the fatal GPU loop.
2. Drive one adapter turn and confirm cmd.exe emits no UNC warning and the agent observes the intended workspace, not `C:\Windows`.

Do not claim packaged UNC startup is fixed until this passes.

### B. Packaged Electron-as-Node launcher behavior

The launcher and its acpx command wiring are implemented and covered by cross-platform unit tests.
The manual check above validates a complete Codex ACP exchange, cancellation, and teardown through the outer GUI process from the WSL network share.
It does not validate the equivalent Claude path or a package on a native local drive.

**Remaining clean-Windows validation step:**
1. On a clean Windows 11 x64 VM, place a temporary packaged Electron app under a path with spaces/non-ASCII on a short native local drive, and drive both bundled adapters through the outer `--baby-menu-electron-node-launcher` process over ACP.
2. Confirm WSL-proven child-env scoping, clean ACP stdout, launcher exit propagation, and normal/forced teardown for both native agent installations.

Do not claim both adapter launches work from a native packaged install until this passes.
Setting `ELECTRON_RUN_AS_NODE` globally in the Electron main process remains rejected as too broad — it would propagate to every host child (git, taskkill, background-task shells).

### C. Native Windows agent credentials and `.cmd` cancellation

The manual check proves `taskkill /T /F /PID <pid>` removes a real project-local `codex.cmd` process tree (including an authenticated Codex CLI and live tool descendant through `wsl.exe`).
A native Windows agent installation was not available.

**Remaining clean-Windows validation step:**
1. On the clean VM, drive one real prompt through each natively installed supported agent and cancel/timeout it mid-turn.
2. Assert no native `claude*`, `codex*`, `node`, or tool-process descendant survives (e.g. via `tasklist` after the turn settles).

### D. The broader test suite on Windows

The `windows` CI job runs only platform-portable unit files and prompt transport regressions.
Many specs execute `/bin/bash`/`/bin/sh`, rely on Unix fixtures (shebangs, `chmod`, symlinks), or are explicitly `skipIf(win32)`.
Porting core ACP/change-session e2e (removing win32 skips in `tests/e2e-acp-runtime.test.ts`) is not done here.

### E. Out of scope for this milestone entirely

Tray polish/assets, `.ico`, AppUserModelID, single-instance lock, NSIS installer, Authenticode signing, update copy, recipe platform-filtering/parity, or any greenfield rewrite.
