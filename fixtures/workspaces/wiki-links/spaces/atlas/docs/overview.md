# Field Atlas

A hub doc for the link-graph demo. Every doc here starts **unreviewed** (fixtures carry no edit history), so trust signals begin honest — edit or review a doc in the UI and watch them flip.

Try, over MCP or REST:

- `worktable_docs_read` action `read` on this doc → `links` below resolve, except the changelog
- `worktable_docs_read` action `read` on [the API reference](/reference/api) → two `backlinks`
- `worktable_docs_read` action `list` → `backlinkCount` per doc; the scratchpad has none
- Open a doc in the UI, then read it again → `humanReviewed` flips true; let an agent edit it → flips back

## Contents

- [Setup guide](/guides/setup) — absolute link from the docs root
- [Usage guide](/guides/usage)
- [API reference](/reference/api)
- [Changelog](/reference/changelog) — deliberately unwritten: a legal broken link
