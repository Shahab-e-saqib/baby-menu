# Windows release workflow

The `Release Windows` workflow (`.github/workflows/release-windows.yml`) builds an x64 NSIS installer on a native Windows runner and publishes it to a GitHub Release.

## Triggers

- **Push to a `v*` tag** (e.g. `v0.2.0`): builds the installer, enforces Authenticode signing, renames the verified signed installer (removing the `-unsigned` suffix), computes a SHA-256 checksum, and publishes both to the GitHub Release. If the GitHub Release does not exist yet, the workflow creates it safely.
- **Manual `workflow_dispatch`**: builds the unsigned installer, computes the checksum, uploads the build artifacts with 7-day retention. No GitHub Release publication occurs.

## Jobs and permissions

The workflow uses two jobs with narrowly scoped permissions:

| Job | Permissions | Purpose |
|---|---|---|
| `build` | `contents: read` | Checkout, build, sign, verify, rename, checksum, upload artifact |
| `publish` | `contents: write` | Download artifact, create/verify release, upload assets |

The top-level `permissions: {}` denies all permissions by default; each job explicitly requests only what it needs.

## Signing

Public GitHub Releases require Authenticode signing. Set these repository secrets:

| Secret | Description |
|---|---|
| `WIN_CSC_LINK` | Base64-encoded PKCS#12 (`.pfx`) Authenticode certificate |
| `WIN_CSC_KEY_PASSWORD` | Password for the `.pfx` certificate |

The workflow refuses to proceed with a tag-triggered release when either secret is missing. After building, `Get-AuthenticodeSignature` verifies the installer is validly signed before the rename step. Signing material is never printed, persisted, or uploaded.

## Rename

After signature verification, the workflow renames the installer from `Baby-Menu-<version>-x64-unsigned.exe` to `Baby-Menu-<version>-x64.exe` before computing the checksum and publishing.

## Release safety

The `publish` job uses explicit `$LASTEXITCODE` from `gh release view` (never `2>$null` PowerShell suppression) to detect whether a GitHub Release already exists for the tag. On a missing release, it creates a **draft** release (`--draft`) before uploading. Assets are uploaded to the draft, and only after a successful upload is the draft published (`gh release edit --draft=false`). This prevents a failed upload from leaving an empty public release. Pre-existing releases (e.g. created by `release-please`) are never toggled through draft state — they receive assets directly.

## Release output

Each tag-triggered run uploads these assets to the matching GitHub Release:

- `Baby-Menu-<version>-x64.exe` — Signed NSIS installer
- `Baby-Menu-<version>-x64.exe.sha256` — SHA-256 checksum file

## Unsigned internal preview

Running `pnpm package:win` locally or triggering the workflow manually via `workflow_dispatch` produces an unsigned x64 NSIS installer. The unsigned artifact name (`Baby-Menu-*-x64-unsigned.exe`) is preserved. Manual runs never publish to a GitHub Release.

## No Chocolatey or Winget

This workflow does not publish to Chocolatey, Winget, or any package manager.

## Workflow-contract tests

See `tests/windows-release-workflow.test.ts` for assertions covering triggers, permissions, signing guards, rename, artifact matching, retention, release creation, and publication behavior.
