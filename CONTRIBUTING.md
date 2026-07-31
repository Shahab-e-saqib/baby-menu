# Contributing

Thanks for wanting to contribute.
One rule up front:

**Human-authored pull requests targeting `main` must be raised through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes).**
We require this to reduce the maintainer's burden of reviewing and merging contributions.

`no-mistakes` puts a local git proxy in front of your real remote.
Pushing through it runs an AI-driven review, test, lint, and CI pipeline in an isolated worktree, forwards the push upstream only after every check passes, and opens a clean PR automatically.

A GitHub Actions check named `Require no-mistakes` runs on PRs targeting `main` and fails if the body is missing the deterministic signature that no-mistakes writes.
Known automation accounts are exempt so dependency and release automation can keep working.
Regular contributor PRs without the signature will not be reviewed or merged.

## Workflow

Fork routing requires `no-mistakes` v1.30.1 or newer.

1. Fork the repo, then clone the parent repo or set your local `origin` back to the parent repo (`git@github.com:kunchenguid/baby-menu.git`).
2. Create a branch and make your changes.
3. Initialize or refresh the gate with your fork as the push target: `no-mistakes init --fork-url git@github.com:<you>/baby-menu.git`.
4. Commit your changes.
5. Push through the gate instead of pushing to `origin`: `git push no-mistakes`.
6. Run `no-mistakes` to attach to the pipeline, watch findings, and auto-fix or review as needed.
7. Once the pipeline passes, it pushes the branch to your fork and opens the PR against this repo for you.

See the [no-mistakes quick start](https://kunchenguid.github.io/no-mistakes/start-here/quick-start/) for the full first-run walkthrough.

## Repo Conventions

- Use `pnpm` with the pinned version from `packageManager`.
- Tests live in `tests/` at the repo root.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before pushing.
- Run `pnpm generate:contracts` and commit `extensions/babymenu-env.d.ts` after changing extension-facing types or `src/shared/extension-contract-names.ts`.
- Run `pnpm package:mac` when changing packaging, runtime paths, extension compilation, native dependencies, or release behavior.
- Local `pnpm package:mac` builds intentionally produce `Baby Menu Dev.app` with bundle id `com.kunchenguid.baby-menu.dev`; release automation uses `electron-builder.yml` directly for the production `Baby Menu.app` identity.
- Follow the universal native-dependency, build-only esbuild exclusion, and packaged runtime verification constraints in [`docs/development.md`](docs/development.md#packaging).
- Keep `pnpm-lock.yaml` changes with dependency changes.
- Do not commit generated build output, release artifacts, runtime caches, or dev extension workspaces.
- Do not hand-edit release-please metadata such as `CHANGELOG.md` or `.release-please-manifest.json`.
- See `AGENTS.md` for architecture notes, extension workspace rules, and agent-specific constraints.

## Release Notes

Baby Menu releases are proposed by release-please after conventional commits land on `main`.
Use prefixes such as `feat:` and `fix:` so release-please can choose the version bump and release notes.
Mark breaking changes with `!` in the commit type or a `BREAKING CHANGE:` footer.
Merging the release-please PR creates the version tag and a draft GitHub Release.
The release-please workflow builds the universal macOS app, applies a credential-free ad-hoc signature (not a Developer ID signature or notarization), verifies the packaged runtime, uploads the DMG, publishes the release, and then updates `kunchenguid/homebrew-tap` with the release checksum.
Any build, verification, checksum, or GitHub upload failure leaves the release as a draft and stops before the Homebrew update. A missing or invalid `HOMEBREW_TAP_TOKEN`, or another tap update failure, occurs after publication and fails the workflow without updating Homebrew.
The generated Homebrew Cask quits Baby Menu during upgrade and relaunches it after installation only when the app was already running before uninstall started.
Maintainers must keep `HOMEBREW_TAP_TOKEN` configured with write access to `kunchenguid/homebrew-tap` for the final cask update.
Maintainers must also keep the `BABY_MENU_UMAMI_WEBSITE_ID` GitHub Actions repository variable configured for packaged-release telemetry; it is intentionally a variable rather than a secret because the id is baked into the app and sent in Umami payloads.

To release, merge the release-please PR and require the `release-please` workflow's macOS job to pass. The release remains a draft until its ad-hoc-signed artifact passes packaged runtime verification, receives a valid checksum, and uploads successfully. Do not upload a replacement DMG or update the tap by hand.

## Questions

Open an issue if something is unclear.
