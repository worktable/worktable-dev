# OpenClaw adapter releases

The adapter source lives in `packages/openclaw-plugin` in this repository.
Canonical Worktable skills live in `plugins/worktable/skills` and are copied into
the package during its build. Edit those sources rather than generated package
outputs.

## Prepare a release

1. Make the change in the canonical source and update the package and plugin manifest versions together.
2. Merge the reviewed pull request and confirm all required checks pass.
3. Confirm the `OpenClaw plugin / Verify` check succeeds on `main`.
4. Create a protected tag named `openclaw-v<package-version>` at that exact
   public commit. Do not create a GitHub Release, because Worktable's installer
   uses the repository's latest application release.
5. Build once from the protected tag with Bun 1.3.14 and retain the printed
   SHA-256 digest.

The package version, plugin manifest version, and tag version must match. A
ClawHub version is immutable; a failed or withdrawn version is replaced by a
new patch version rather than overwritten.

## First ClawHub publication

The first release is manual. From a clean checkout of the protected tag:

```sh
cd packages/openclaw-plugin
bun install --frozen-lockfile
bun run pack:dogfood
clawhub package publish ./artifacts/worktable-openclaw-<version>.tgz \
  --family code-plugin \
  --owner worktable \
  --name openclaw \
  --display-name Worktable \
  --version <version> \
  --changelog "<release summary>" \
  --tags latest \
  --source-repo worktable/worktable-dev \
  --source-commit "$(git rev-parse HEAD)" \
  --source-ref "openclaw-v<version>" \
  --source-path packages/openclaw-plugin \
  --dry-run
```

Review the dry-run output, then repeat without `--dry-run`. Wait for ClawHub's
security scan to become clean before changing Worktable's user-facing install
command. Download the published package and verify its SHA-256 against the
locally retained artifact.

After the first release exists, configure ClawHub trusted publishing for this
repository and a dedicated, commit-pinned `workflow_dispatch` workflow. Never
publish from a mutable branch or an unpinned reusable workflow.
