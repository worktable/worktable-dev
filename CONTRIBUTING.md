# Contributing to Worktable

Fixes and documentation improvements are welcome. Before implementing a substantial
feature, open an [issue](https://github.com/worktable/worktable-dev/issues/new?template=feature_request.yml)
to agree on the problem, scope, and approach.

Start with [Development](docs/development.md) for local setup and canonical tests,
or [Building](docs/building.md) for release artifacts. Include
the smallest verification that demonstrates the changed behavior. Preserve
existing data formats, authentication boundaries and supported integrations.
Run generated-file checks when changing their inputs; do not hand-edit generated
outputs. Explain the concrete behavior and evidence in your pull request.

For questions, use [Q&A](https://github.com/worktable/worktable-dev/discussions/categories/q-a).
For a bug, include the version, platform, and a minimal reproduction in the
[bug report form](https://github.com/worktable/worktable-dev/issues/new?template=bug_report.yml).

## Licenses and contribution rights

Contributions use the license that applies to the file being changed. The
application default is AGPL-3.0-only. Exact shared MIT exceptions are identified
in their package notices, including the scoped UI notice; adding a file to the
UI does not automatically make it MIT. Preserve upstream copyrights and notices.
Do not submit material you lack permission to contribute under its file license.

Certify each contribution under the [Developer Certificate of Origin](./DCO).
Use `git commit -s` to add your sign-off. Choose the name and email you intend to
make public; a GitHub-provided noreply address is acceptable. A sign-off certifies
contribution rights. It does not transfer copyright or grant additional rights
to relicense community contributions under a proprietary license.

## Review before uploading

Commits, branches, pull requests, issues and attachments may be public as soon as
you upload them. Check your diff and files first. Do not include credentials,
private workspaces, customer information, personal notes or unreviewed logs and
screenshots. Use a minimal example with synthetic data when reporting a problem.
Automated checks run after upload and cannot undo an earlier disclosure.

Do not disclose a security vulnerability in a public issue. Use the project's
[security contact](https://www.worktable.dev/security) for private reporting.
