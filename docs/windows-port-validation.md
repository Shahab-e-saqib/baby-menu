# Windows port: current state and remaining validation

This document records what the **first Windows-port milestone** (PR) implements,
what it deliberately proves, and - crucially - what it does **not** claim to
prove, because those proofs require a real Windows host that is not available in
the development environment. It is the honest companion to the spike work; treat
anything in this list marked "needs clean-Windows validation" as **not yet
shipped for Windows**, even though the host-side plumbing is in place.

The roadmap source of truth is the feasibility report at
`data/baby-menu-windows-scout/report.md` (outside the repo copy); the staged
plan there is authoritative. This document only covers the first milestone.

## What this milestone implements and validates automatically

All of the following are covered by automated tests that pass on the current
host and on the `windows-latest` CI job added in `.github/workflows/ci.yml`:

1. **Platform-safe PATH handling** (`src/main/shell-path.ts`)
   - `mergeShellPath` no longer appends Unix directories or a `:` delimiter on
     Windows; it returns the inherited PATH unchanged (Windows already inherits
     the merged system+user PATH from the registry). Regression test in
     `tests/shell-path.test.ts` covers the final-entry-corruption defect,
     multiple drive letters, and preserved POSIX behavior.

2. **Correctly-quoted bundled-adapter launch path** (`src/main/launch-command.ts`)
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

3. **PATHEXT / `.cmd`-aware native agent launching** (`src/adapters/shared/platform-spawn.ts`)
   - `resolveDriverCommand` resolves a bare command to its `.cmd` shim via
     PATHEXT and PATH search (mirrors acpx's own resolution); `driverSpawnOptions`
     sets `shell: true` for `.cmd`/`.bat` shims so Node can launch them. Both
     drivers (`claude`, `codex`) now resolve and spawn through these helpers.
     Covered by `tests/platform-spawn.test.ts`.

4. **Bounded Windows process-tree cancellation** (`src/adapters/shared/process-tree.ts`)
   - `createChildTerminator` keeps the exact POSIX `SIGTERM` -> `SIGKILL` behavior
     (so existing driver tests are unchanged) and, on Windows, runs
     `taskkill /T /F /PID <pid>` with a numeric pid (no shell interpolation of
     untrusted text). Both drivers cancel and dispose through the terminator.
     Covered by `tests/process-tree.test.ts`.

5. **`pnpm.cmd`-safe dev launcher** (`scripts/dev.mjs`)
   - Package-manager invocations run through `shell: true` so `pnpm.cmd` resolves
     on Windows. Covered by `tests/dev-launcher.test.ts`.

6. **Windows CI** (`.github/workflows/ci.yml`, `windows` job)
   - Runs `pnpm typecheck`, `pnpm build`, and the five platform-portable test
     files above on `windows-latest`.

## What this milestone does NOT prove (needs clean-Windows validation)

These items require a real, packaged Windows runtime and are the documented
remaining steps for the full port. The spike intentionally does not pretend they
passed.

### A. Delivering `ELECTRON_RUN_AS_NODE` to the bundled adapter on Windows

On POSIX, `buildAdapterLauncherTokens` scopes `ELECTRON_RUN_AS_NODE=1` to the
adapter child via a leading `env KEY=VALUE` prefix in the command string. There
is no `env` command on Windows, and acpx's registry override is a single command
**string** that acpx reparses - it has no structured `{ executable, args, env }`
surface and it builds the child environment from the host's `process.env`
(plus auth), so env cannot be injected through the command string either.

Consequence: on Windows, `buildAdapterLauncherTokens` omits the env and the
launch command is just `<executable> <adapter-path>` (correctly quoted). The
command string is correct, but running the bundled Electron binary as Node
requires the env var, which means a small launcher is needed.

**Remaining clean-Windows validation step (report Milestone 0):**
1. Author a minimal Windows launcher (a `.cmd` shim that sets
   `ELECTRON_RUN_AS_NODE=1` and execs the bundled Electron with the adapter
   path, OR a tiny signed executable), pointed at by `buildAdapterLauncherTokens`
   on `win32`.
2. On a clean Windows 11 x64 VM, build a temporary packaged Electron app under a
   `C:\Program Files\...` path with spaces/non-ASCII, and prove
   Electron-as-Node launches one bundled ACP adapter with the env set safely and
   ACP stdout uncontaminated.
3. Prove `splitAcpxCommand` of the produced `launchCommand` reparses to the exact
   launcher + adapter tokens (extend `tests/launch-command.test.ts`).

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

### C. `shell: true` + prompt-as-argv hardening

The drivers pass the user prompt as a trailing positional argv
(`claude -p <prompt>`, `codex exec <prompt>`). On Windows, `.cmd` shims require
`shell: true`, under which Node's argv quoting is not fully injection-proof
against cmd.exe metacharacters (`&`, `|`, `%`). This is a pre-existing driver
design surfaced by the Windows port.

**Remaining hardening step (full port):** move prompt delivery off the argv
(over stdin, mirroring how acpx itself carries prompts), or sanitize/quoting-
harden the prompt path. Out of scope for this first milestone; flagged here so it
is not lost.

### D. The broader test suite on Windows

The `windows` CI job intentionally runs only the five platform-portable unit
files. Many other specs execute `/bin/bash`/`/bin/sh`, rely on Unix fixtures
(shebangs, `chmod`, symlinks), or are explicitly `skipIf(win32)`. Porting the
core ACP/change-session e2e to Windows (removing the win32 skips in
`tests/e2e-acp-runtime.test.ts`) is report Milestone 1's exit criterion and is
not done here.

### E. Out of scope for this milestone entirely

Per the task scope, none of the following are in this PR: tray polish/assets,
`.ico`, AppUserModelID, single-instance lock, NSIS installer, Authenticode
signing, update copy, recipe platform-filtering/parity, or any greenfield
rewrite. See the report's staged plan (Milestones 2-5).
