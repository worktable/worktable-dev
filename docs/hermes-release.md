# Hermes releases

The plugin lives in `packages/hermes-plugin`. Hermes installs plugins straight
from Git, so the package carries a checked-in copy of the agent plugin's
skills; regenerate it with `bun run generate:hermes-skills` rather than editing
`packages/hermes-plugin/skills`.

## Prepare a release

1. Make the change, update `version` in `plugin.yaml` and `pyproject.toml`
   together, and add a `CHANGELOG.md` entry.
2. Merge the reviewed pull request and confirm the `Hermes plugin / Verify`
   check succeeds on `main`.
3. Create a protected tag named `hermes-v<version>` at that commit. Do not
   create a GitHub Release, because Worktable's installer uses the repository's
   latest application release.

`hermes plugins install worktable/worktable-dev#packages/hermes-plugin` installs
the default branch. Users can pin a release with `--ref <commit>`.

## Hermes plugin catalog

The catalog lists a plugin at an exact commit. After tagging, open a pull
request to [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
that adds or updates `plugin-catalog/worktable.yaml` following its
[submission guide](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/catalog-submission):

- `repo: worktable/worktable-dev`, `subdir: packages/hermes-plugin`, and the
  tagged commit's full 40-character `sha`;
- `category: platform`, `requires_hermes` from `plugin.yaml`, and the version;
- a description that discloses the network calls to the connected Worktable and
  where credentials are stored (see the plugin README).

Catalog CI runs `hermes plugins validate --install-deps`. Run it locally on the
tagged commit first. Once the entry is merged, switch the install command in
Settings and the documentation to `hermes plugins install worktable`.
