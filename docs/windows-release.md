# Windows release workflow

The `Release Windows` workflow (`.github/workflows/release-windows.yml`) builds an x64 NSIS installer on a native Windows runner, signs it, and publishes it to a GitHub Release.

## Triggers

- **Push to a `v*` tag** (e.g. `v0.2.0`): builds the installer, enforces Authenticode signing (via Trusted Signing or PFX fallback), renames the verified signed installer (removing the `-unsigned` suffix), computes a SHA-256 checksum, and publishes both to the GitHub Release. If the GitHub Release does not exist yet, the workflow creates it safely.
- **Manual `workflow_dispatch`**: builds the unsigned installer, uploads the build artifacts with 7-day retention. No signing or GitHub Release publication occurs.

## Jobs and permissions

The workflow uses three jobs with narrowly scoped permissions:

| Job | Permissions | Environment | Purpose |
|---|---|---|---|
| `build` | `contents: read` | — | Checkout, build, typecheck, test, produce NSIS installer, resolve installer, compute checksum (manual), upload candidate (tag) or installer+checksum (manual) |
| `sign` | `contents: read`, `id-token: write` | `windows-release` | Download candidate, resolve installer, sign (Trusted Signing) or verify (PFX), rename, checksum, upload release artifact |
| `publish` | `contents: write` | — | Download release artifact, create/verify release, upload assets |

The top-level `permissions: {}` denies all permissions by default; each job explicitly requests only what it needs.
The `id-token: write` permission on `sign` is required for OIDC-based Azure Trusted Signing authentication and uses the `windows-release` environment for the federated credential subject (`repo:Shahab-e-saqib/baby-menu:environment:windows-release`).

## Signing

Public GitHub Releases require Authenticode signing. Trusted Signing is the preferred provider; PFX is the backward-compatible fallback.
Provider selection happens in the `sign` job, which runs only on tag pushes.

### Trusted Signing (preferred)

Azure Trusted Signing uses short-lived, HSM-backed certificates (no private key file to manage) and authenticates through OpenID Connect (OIDC) federated credentials—no long-lived secrets.

Set these repository **variables** (not secrets):

| Variable | Description |
|---|---|
| `AZURE_TENANT_ID` | Azure Entra ID tenant (directory) ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
| `AZURE_CLIENT_ID` | Entra ID app registration (service principal) client ID |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | Trusted Signing endpoint URI, e.g. `https://wus2.codesigning.azure.net/` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_CERT_PROFILE` | Certificate profile name |

All six variables must be set, or none. Partial configuration is detected and rejected at runtime.

Set these resource requirements in Azure:

1. **Azure subscription with Trusted Signing enabled** (requires Microsoft identity verification).
2. **App Registration** (service principal) with a federated credential that trusts the GitHub Actions OIDC issuer (`https://token.actions.githubusercontent.com`) with:
   - **Issuer**: `https://token.actions.githubusercontent.com`
   - **Subject**: `repo:Shahab-e-saqib/baby-menu:environment:windows-release`
   - **Audience**: `api://AzureADTokenExchange`
3. **Trusted Signing account** with a certificate profile.
4. **Role assignment**: the service principal must have the **Artifact Signing Certificate Profile Signer** role on the Trusted Signing account.
5. Repository variables listed above.

### PFX fallback (backward compatible)

When none of the six Trusted Signing variables are set, the workflow falls back to the traditional PFX certificate. Set these repository **secrets**:

| Secret | Description |
|---|---|
| `WIN_CSC_LINK` | Base64-encoded PKCS#12 (`.pfx`) Authenticode certificate |
| `WIN_CSC_KEY_PASSWORD` | Password for the `.pfx` certificate |

### Precedence

1. If all six `AZURE_*` variables are non-empty, the workflow uses Trusted Signing.
2. If some but not all six are set, the workflow **fails** with a clear error listing the missing variables.
3. Otherwise, if `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are set, the workflow uses PFX.
4. If no signing provider is configured, a tag-triggered release fails at the sign job guard.

## Signing flow

**Trusted Signing path:**

1. `build`: Electron-builder produces unsigned installer (`Baby-Menu-*-x64-unsigned.exe`) without `CSC_LINK`/`CSC_KEY_PASSWORD`. Candidate uploaded.
2. `sign`: Downloads candidate, resolves the single `.exe`, Azure login via OIDC (`windows-release` environment), signs that exact file with Trusted Signing (`timestamp.acs.microsoft.com` RFC3161 timestamp), verifies Authenticode + timestamp, renames to remove `-unsigned`, computes SHA-256, uploads release artifact.

**PFX fallback path:**

1. `build` (tag only): Electron-builder produces signed installer with `CSC_LINK`/`CSC_KEY_PASSWORD` (gated on `startsWith(github.ref, 'refs/tags/')`). Candidate uploaded.
2. `sign`: Downloads candidate, resolves the single `.exe`, verifies Authenticode + timestamp (signing already done during build), renames to remove `-unsigned`, computes SHA-256, uploads release artifact.

Both paths converge at the verification step. Signing material is never printed, persisted, or uploaded.

## Timestamp

All signed installers carry an RFC3161 timestamp. The sign job explicitly checks for timestamp presence via `Get-AuthenticodeSignature.TimeStamperCertificate`. This is critical for Trusted Signing's short-lived (72-hour) certificates—without a timestamp the signature would become invalid after certificate renewal.

## Rename

After signature verification, the sign job renames the installer from `Baby-Menu-<version>-x64-unsigned.exe` to `Baby-Menu-<version>-x64.exe` before computing the checksum and uploading.

## Release safety

The `publish` job uses explicit `$LASTEXITCODE` from `gh release view` (never `2>$null` PowerShell suppression) to detect whether a GitHub Release already exists for the tag. On a missing release, it creates a **draft** release (`--draft`) before uploading. Assets are uploaded to the draft, and only after a successful upload is the draft published (`gh release edit --draft=false`). This prevents a failed upload from leaving an empty public release. Pre-existing releases (e.g. created by `release-please`) are never toggled through draft state — they receive assets directly.

## Release output

Each tag-triggered run uploads these assets to the matching GitHub Release:

- `Baby-Menu-<version>-x64.exe` — Signed NSIS installer
- `Baby-Menu-<version>-x64.exe.sha256` — SHA-256 checksum file

## Unsigned internal preview

Triggering the workflow manually via `workflow_dispatch` always produces an unsigned x64 NSIS installer — `CSC_LINK`/`CSC_KEY_PASSWORD` are gated on `startsWith(github.ref, 'refs/tags/')` so manual runs never receive signing credentials. The unsigned artifact name (`Baby-Menu-*-x64-unsigned.exe`) is preserved. Manual runs never publish to a GitHub Release.

The build job resolves the single installer, computes its SHA-256 checksum, and uploads both as the `baby-menu-win-x64-installer` artifact with 7-day retention:
- `Baby-Menu-<version>-x64-unsigned.exe`
- `Baby-Menu-<version>-x64-unsigned.exe.sha256`

Running `pnpm package:win` locally also produces an unsigned installer at `release/Baby-Menu-<version>-x64-unsigned.exe`.

## Artifact flow (tag path)

On tag pushes, the jobs pass artifacts through two separate uploads to separate concerns:

| Step | Artifact | Contents | Retention |
|---|---|---|---|
| Build → candidate | `baby-menu-win-x64-candidate` | `.exe` only | 1 day |
| Sign → release | `baby-menu-win-x64-release` | Renamed `.exe` + `.sha256` | 1 day |
| Publish consumes | `baby-menu-win-x64-release` | — | — |

The candidate handoff carries only the unsigned `.exe` to the sign job. The sign job signs (or verifies), renames, checksums, and produces the release artifact. On manual dry-run, the build job uploads the installer + checksum directly as `baby-menu-win-x64-installer` (7-day retention), skipping the sign and publish jobs entirely.

## Commit SHA pinning evidence

Azure actions used in this workflow are pinned to peeled commit SHAs (not annotated tag objects) verified via:

```
git ls-remote https://github.com/Azure/login.git refs/tags/v3.0.0^{}
# 532459ea530d8321f2fb9bb10d1e0bcf23869a43

git ls-remote https://github.com/Azure/artifact-signing-action.git refs/tags/v2.0.0^{}
# c7ab2a863ab5f9a846ddb8265964877ef296ee82
```

The `^{}` suffix dereferences the annotated tag to its underlying commit. Only that commit SHA appears in the workflow `uses:` lines.

## No Chocolatey or Winget

This workflow does not publish to Chocolatey, Winget, or any package manager.

## Workflow-contract tests

See `tests/windows-release-workflow.test.ts` for assertions covering triggers, permissions, signing guards, rename, artifact matching, retention, release creation, and publication behavior.
