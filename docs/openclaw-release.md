# OpenClaw adapter releases

The standalone adapter source lives in `plugins/openclaw`. It is generated
from the private Worktable authoring repository by an explicit file allowlist;
`SOURCE.json` records the upstream revision and hashes every exported file.

## Prepare a release

1. Merge and fully verify the corresponding private Worktable change.
2. Generate a public-source update and merge it through a pull request.
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
cd plugins/openclaw
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
  --source-path plugins/openclaw \
  --dry-run
```

Review the dry-run output, then repeat without `--dry-run`. Wait for ClawHub's
security scan to become clean before changing Worktable's user-facing install
command. Download the published package and verify its SHA-256 against the
locally retained artifact.

After the first release exists, configure ClawHub trusted publishing for this
repository and a dedicated, commit-pinned `workflow_dispatch` workflow. Never
publish from a mutable branch or an unpinned reusable workflow.
