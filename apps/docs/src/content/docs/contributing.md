---
title: Contributing
description: Build Worktable, report problems, and contribute changes to the public application.
---

Worktable's application source is public under AGPL-3.0-only. Some shared
components and agent packages have MIT licenses; the repository's
[notices](https://github.com/worktable/worktable-dev/blob/main/NOTICE) identify
those exceptions.

## Get involved

- [Report a problem](https://github.com/worktable/worktable-dev/issues/new/choose)
  with steps to reproduce it, the version, and how you run Worktable.
- [Propose a change](https://github.com/worktable/worktable-dev/blob/main/CONTRIBUTING.md)
  and follow the contribution and DCO instructions.
- [Report a vulnerability](https://github.com/worktable/worktable-dev/blob/main/SECURITY.md)
  through the private reporting channel.

Use synthetic examples in reports and screenshots. Remove credentials and
private workspace content before uploading evidence.

## Develop Worktable

The [development guide](https://github.com/worktable/worktable-dev/blob/main/docs/development.md)
covers dependencies, an isolated workspace, the code layout, and verification.
[Desktop development](https://github.com/worktable/worktable-dev/blob/main/apps/desktop/README.md)
covers native prerequisites.

Use the [building guide](https://github.com/worktable/worktable-dev/blob/main/docs/building.md)
for release artifacts. Hosted operations and the marketing sites are maintained
outside the public application repository.

## Improve documentation

Edit user guides in `apps/docs/src/content/docs`. Agent workflow pages come from
the skills in `plugins/worktable/skills` (bundled with the agent plugin) and
`skills/` (installed separately); command, tool, and runtime references come
from their owning source. Edit those sources and regenerate the pages.

Keep titles short, explain the action directly, and check examples against the
current product. Follow the development guide's documentation checks before
submitting a change.
