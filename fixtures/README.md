# Workspace fixtures

These workspaces contain synthetic test data. People, organizations, business
figures, product plans, incidents, and conversations are fictional. They do not
describe Worktable's customers, roadmap, finances, or service guarantees.

The founder scenario follows **Cedarline**, a fictional project-delivery company.
Its workspace name, documents, and dashboard identify it as a demo.

## Generate

The canonical definitions live in
[`packages/server/src/fixtures`](../packages/server/src/fixtures). Edit those
sources, then regenerate; do not hand-edit generated workspace files.

```sh
bun run fixtures:generate -- --only founder
bun run fixtures:verify
```

The generator uses isolated staging directories and deterministic identities.
Verification rebuilds into temporary directories and compares the output.

## Compatibility cases

Some fixtures deliberately retain legacy storage, broken links, orphaned
content, or unusual paths. These exercise supported reading and recovery
behavior. Preserve the case when changing its explanatory copy; they are not
recommended templates for new workspaces.

Use isolated copies for development and browser checks. Do not mix fixture data
with a personal workspace.
