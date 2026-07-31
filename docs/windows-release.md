# Windows installer preview

The `Windows Installer Preview` workflow (`.github/workflows/release-windows.yml`) builds an unsigned x64 NSIS installer on a GitHub-hosted Windows runner for internal evaluation.

## Scope

The workflow is deliberately limited to `workflow_dispatch`. It has no tag trigger, release publication job, signing job, deployment environment, or signing credential inputs. Windows signing is deferred.

The generated installer remains explicitly named:

- `Baby-Menu-<version>-x64-unsigned.exe`
- `Baby-Menu-<version>-x64-unsigned.exe.sha256`

The workflow uploads both files as the `baby-menu-win-x64-unsigned-internal-preview` Actions artifact with seven-day retention. It does not create or update a GitHub Release and does not represent the installer as trusted or production-ready.

## Build behavior

The single job has `contents: read` permission, installs locked dependencies, runs typecheck and tests, builds the application, and invokes electron-builder for Windows x64. `CSC_IDENTITY_AUTO_DISCOVERY=false` prevents certificate auto-discovery, and the deterministic resolver accepts only the `-unsigned.exe` artifact name before computing its SHA-256 checksum.

Running `pnpm package:win` locally likewise produces an unsigned installer under `release/`, using the separate **Baby Menu Dev** product name and `com.kunchenguid.baby-menu.dev` application identity so the preview does not collide with an installed production build.

## Validation

`tests/windows-release-workflow.test.ts` protects the manual-only trigger, read-only permissions, absence of signing and publication configuration, explicit unsigned filename, checksum, and internal-preview artifact retention.
