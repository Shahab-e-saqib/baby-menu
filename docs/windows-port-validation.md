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

10. **Windows CI** (`.github/workflows/ci.yml`, `windows` job) — runs `pnpm typecheck`, `pnpm build`, and **39 test files** on `windows-latest`: the five platform unit files, both stdin prompt regressions, 31 extension/widget/agent/app-support unit files, and the package-content assertion after building `win-unpacked`.
    Its packaged-binary sanity check verifies the PE header and exercises the packaged executable only through a bounded `ELECTRON_RUN_AS_NODE` script; it does not claim GUI persistence on a GitHub-hosted runner.
    Deferred test categories (each with a concrete reason in the CI comment):
    `e2e-acp-runtime` (real ACP subprocess + git + acp-mock), `e2e-adapters` (real Claude/Codex CLIs), `e2e-grok-quota-refresh` (real Grok OIDC creds), `app-lifecycle*.test.ts` (Electron GUI lifecycle), `tray.test.ts` (Electron Tray/nativeImage APIs), `popover-*.test.ts` (Electron BrowserWindow / screen bounds), `grok-quota-generated-install` (POSIX process-group signals), `renderer/*` plus widget-host/widget-canvas/agent-chat/settings-* (jsdom/React), `widget-protocol.test.ts` (Electron binary not guaranteed on Windows runners).
    `.github/workflows/ci.yml`.

11. **Windows ICO icon assets** (`assets/app-icon.ico`, `assets/tray/baby_menu.ico`, `scripts/generate-windows-icons.mjs`) — deterministic ICO generation from the same vector source used for the macOS `iconTemplate.png`.
    `tests/windows-icon-assets.test.ts` proves the ICO contains the required format entries (16x16, 32x32, 48x48) and matches the PNG checksum.

12. **Platform-aware tray icon loading** (`src/main/app-paths.ts`, `src/main/tray.ts`) — `trayIconPath` resolves to `baby_menu.ico` on Windows and `baby_menuTemplate.png` on macOS.
    The tray icon loads from the correct path per platform; on Windows the `.ico` file is not set as a template image.
    `tests/tray.test.ts` (platform stubs), `tests/app-paths.test.ts` (path resolution per platform).

13. **Windows tray tooltip, context menu, and onOpen/onQuit callbacks** (`src/main/tray.ts`) — `createBabyMenuTray` accepts optional `onOpen` and `onQuit` callbacks.
    On Windows the tray sets a tooltip ("Baby Menu") and builds an **Open Baby Menu** / **Quit** context menu. **Open Baby Menu** always shows or focuses the popover; clicking the tray icon retains toggle behavior.
    `tests/tray.test.ts`, `tests/app-lifecycle-windows.test.ts`.

14. **AppUserModelID and single-instance lock** (`src/main/app.ts`) — `app.setAppUserModelId` runs before `app.whenReady()` on Windows, using `com.kunchenguid.baby-menu` for the production executable and `com.kunchenguid.baby-menu.dev` for source/dev or packaged **Baby Menu Dev** previews.
    `app.requestSingleInstanceLock()` ensures only the first process creates the tray/popover/runtime; a second instance quits after requesting that the primary show or focus its popover. Activations received before tray creation are queued and coalesced until startup is ready.
    Cross-platform unit coverage via the broader app-support test suite.

15. **Windows taskbar-aware popover geometry** (`src/main/popover.ts`, `src/main/app.ts`) — `calculatePopoverBounds` computes the popover position against the taskbar-aware `workArea` (not the full screen) of the display nearest the tray icon.
    `tests/popover-position.test.ts` proves the popover stays within the work area on the expected side of the taskbar without launching Electron.

16. **Unavailable native agent UX** (`src/main/agent-catalog.ts`, `src/main/agent-runtime.ts`, `src/adapters/shared/types.ts`) — Settings keeps Claude Code and Codex visible when their host CLI cannot be found. They remain disabled in Native mode, with provider-specific install, system `PATH`, and restart guidance, but can be selected after explicitly choosing WSL mode on Windows. A persisted unavailable Native selection fails before the bundled adapter starts. If the command disappears or cannot start after the availability probe, adapter errors distinguish not-found, permission-denied, and other startup failures while withholding paths, usernames, environment values, tokens, and provider stderr.
    `tests/agent-catalog.test.ts`, `tests/agent-runtime.test.ts`, `tests/settings-view.test.tsx`.

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
The installed Claude Code and Codex CLIs were available only inside WSL, so this evidence does not satisfy the native Windows host prerequisite. Baby Menu now supports an explicit per-agent WSL mode with preflight validation, but Native mode still requires the provider CLI on the Windows system `PATH` and an app restart after installation.

**Remaining clean-Windows validation step:**
1. On the clean VM, drive one real prompt through each natively installed supported agent and cancel/timeout it mid-turn.
2. Assert no native `claude*`, `codex*`, `node`, or tool-process descendant survives (e.g. via `tasklist` after the turn settles).

### D. The broader test suite on Windows

The `windows` CI job runs 39 test files spanning platform units, extension infrastructure, widget pipeline, agent/runtime, app support, and packaged-content verification.
Many specs execute `/bin/bash`/`/bin/sh`, rely on Unix fixtures (shebangs, `chmod`, symlinks), or are explicitly `skipIf(win32)` — 10 `skipIf(win32)` guards cover symlink, chmod, and Nix-store-specific test cases across `extension-seeder`, `extension-module-compiler`, `widget-tailwind-css`, `layout-module-registry`, and `dev-extension-change-session`.
Porting core ACP/change-session e2e (removing win32 skips in `tests/e2e-acp-runtime.test.ts`) is not done here.

### E. Remaining out-of-scope items

Recipe platform-filtering/parity or any greenfield rewrite.

## Native Windows validation runner

A self-contained PowerShell validation runner lives at `scripts/windows-validate.ps1` (requires Windows PowerShell 5.1+ on a native Windows host from a drive-letter path). It automates deterministic checks over an already-built NSIS installer and documents the boundary between automated evidence and still-manual GUI proof.

**Plan-only (no mutation):**
```
powershell -File scripts/windows-validate.ps1 -InstallerPath <InstallerPath> -InstallDir <InstallDir> -UserDataDir <UserDataDir> -WhatIf
```

**Install/uninstall/launch (all three required together):**
```
powershell -File scripts/windows-validate.ps1 -InstallerPath <InstallerPath> -InstallDir <InstallDir> -UserDataDir <UserDataDir> -AllowInstall -AllowUninstall -AllowLaunch
```

Evidence JSON (pass/fail/skip with secret redaction) is written under `<InstallDir>-diagnostic/evidence-<timestamp>.json` when mutation flags are provided. In `-WhatIf` plan-only mode, evidence is returned in-memory and rendered to stdout with a `PlanOnly=true` marker and no files are created.

**Boundary:** All checks in the runner are either automated deterministic assertions (pass/fail) or explicitly marked `skip` with `ManualGuidance`. The following are genuinely manual GUI-only checks that a human must verify:
- tray icon appearance on the taskbar
- popover open/close/windowing behavior
- widget layout rendering
- settings UI
- agent conversation UI
- Keep/Undo bar interaction

The contract `tests/windows-native-validation.test.ts` validates the runner's structure, guards, and required check domains without executing the script.

## Packaged runtime persistence smoke

A focused PowerShell runner at `scripts/Verify-BabyMenuRuntimeSmoke.ps1` validates the packaged app's runtime persistence without requiring the NSIS installer. The workflow `.github/workflows/windows-persistence-smoke.yml` is `workflow_dispatch`-only and runs against `win-unpacked` on a self-hosted runner explicitly labeled `Windows`, `X64`, and `baby-menu-interactive`; the GitHub-hosted CI workflow does not run this GUI check.

**Scope (automated, single primary launch):**
1. Create fresh temp roots for APPDATA/LOCALAPPDATA/USERPROFILE/HOME and an explicit Electron `--user-data-dir`, isolated from the true user profile and any installed Baby Menu instance.
2. Prove no Baby Menu process is already running from the unpacked directory.
3. Launch the app exactly once via `ProcessStartInfo` with `UseShellExecute=false`, redirected stdout/stderr, isolated env.
4. Poll for 20 seconds, snapshot alive-at-deadline.
5. Record persistence success only if the launch is alive at the deadline; the `finally` path then performs controlled `taskkill /T /F /PID` cleanup when the process is still running.
6. If exited early: capture exit code, parse stdout/stderr for the `second-instance-rejected` JSON marker (safe evidence with SHA-256 digests, never raw env/credentials).
7. An unconditional CIM-based survivor sweep proves no process remains under the unpacked directory; a sweep error or any survivor fails the smoke.
8. Only after survivor proof, restore the parent environment and remove the isolated temp profile; verify environment restoration after the `finally` block.
9. Structured failure evidence JSON written to runner temp, uploaded as a 7-day-retention artifact only on failure.

The smoke uses one ordinary packaged launch and does not pass `--no-sandbox`, `--disable-gpu`, elevation, or retry flags. It therefore leaves the production single-instance lock, Chromium sandbox, native-drive GPU behavior, Windows Defender, and Smart App Control in force.

**Secondary instance behavior** (second launch exits cleanly without STATUS_BREAKPOINT) is covered by unit test in `tests/app-lifecycle-windows.test.ts`, not by a second packaged launch.

**Contract test:** `tests/windows-runtime-smoke-contract.test.ts` validates the runner's structure, parameters, PS5.1 compatibility, security patterns, isolation logic, and evidence format.
