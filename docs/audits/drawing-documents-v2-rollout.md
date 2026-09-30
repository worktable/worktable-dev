# Drawing documents and Storage V2 rollout

Drawing documents work in a prepared Storage V2 workspace, but the ordinary
product does not get new or existing users into that state. Completing delivery
requires fixing first-run setup and workspace import, then exposing a supported
storage upgrade through the existing application lifecycle.

This is an investigation and proposed implementation sequence, dated September
30, 2026, against public main `9074c80629591eb2792c3ec7c6a40615a0cca0ff`.
Synthetic probes used temporary workspaces and separate application state.
The candidate implementation is in this branch; the findings below describe the
baseline, not a released fix. Release and installed-product rollout remain
separate from source verification.

## Confirmed gaps

| Finding | Evidence | Consequence |
| --- | --- | --- |
| New workspaces default to V1 | `prepareWorkspaceTarget` in [workspace.ts](../../packages/server/src/workspace.ts) writes `version: 1`. Desktop calls the CLI workspace preparer, which delegates to this function. | Installing a current release does not make drawings available in a newly created workspace. |
| Drawing creation is hidden on V1 | [app-sidebar.tsx](../../apps/web/src/components/app-sidebar.tsx) checks `workspace.storageVersion === 2`. The generic [document writer](../../packages/server/src/document-write-service.ts) also requires V2. | Exposing the menu alone would produce failed creates. |
| Fresh V2 onboarding fails | A temporary probe created a fresh manifest, selected V2 before seeding, and called `seedStarterWorkspace`. It failed with `HTML document requires a stable ID before mutation: onboarding-board`. | Changing only the default version would break Welcome setup. |
| Imports can mislabel their storage layout | Two temporary probes exercised `beginPreparedWorkspaceReplacement` with opposite source and destination versions. V2 content imported into V1 retained version 1; V1 content imported into V2 retained version 2. | The resulting manifest can select storage handlers inconsistent with the imported files. |
| Upgrade has no product entry point | The repository exposes census and offline rehearsal scripts. The ordinary CLI, workspace HTTP routes and Settings have no storage-upgrade operation. | Existing users cannot complete the prerequisite themselves. |
| Existing reset behavior is too destructive for a format upgrade | `workspaceReset` revokes shares, clears thread deliveries, rotates the collaboration epoch and triggers browser draft/cache deletion. | Reusing import reset unchanged would make a storage-only upgrade discard or invalidate unrelated user state. |

The first-run failure originates in [seed.ts](../../packages/server/src/seed.ts):
starter HTML creation calls `writeWidget` without an admitted document identity.
The V2 branch of [widget-store.ts](../../packages/server/src/widget-store.ts)
requires that identity. Ordinary HTML creation already obtains it through
[html-document-create.ts](../../packages/server/src/html-document-create.ts).
The fix belongs at the seed creation boundary, preserving its atomic publication
and retry behavior; weakening the V2 writer would hide the defect.

The import failure originates in the default `preserve-destination` branch of
[workspace-replacement.ts](../../packages/server/src/workspace-replacement.ts).
It replaces the staged manifest with the current manifest, including the current
storage version. The separate checkpoint-restore branch already recognizes that
layout and content must travel together. Correct ordinary import to preserve
destination identity fields explicitly while retaining the imported layout.
Prove both directions with actual HTML and drawing content, not just manifests.

Do not change unrelated `version: 1` fields mechanically. Onboarding state,
job records, package envelopes and source formats have independent versions.
Legacy import also creates a V1 layout intentionally; it must remain correctly
labeled until an actual upgrade completes.

## Existing machinery to reuse

[document-storage-migration-v2.ts](../../packages/server/src/document-storage-migration-v2.ts)
already provides a substantial conversion engine:

- A census of source documents, durable identities and dependencies, with
  diagnostics for invalid manifests, conflicting namespaces and orphaned
  annotations.
- A sibling staging copy with source and destination checksums.
- Stable document identity materialization and annotation conversion.
- HTML source migration from legacy widget bundles into `docs/`, with metadata,
  runtime state, companions, archive status and history compatibility preserved.
- V2 manifest admission after validation, followed by a verified directory swap.
- Failure rollback and interrupted-swap recovery, with the V1 tree retained after
  a successful migration.

The shipped script exposes `census` and `rehearse`; rehearsal explicitly requires
a separate offline copy. The underlying migration function does not stop a
running server. Calling it directly from an ordinary request would violate the
replacement primitive's requirement that workspace readers and writers be stopped.

The existing directory replacement primitive and recovery journal remain the
conversion commit boundary. Mandatory upgrades run before normal server startup:
a maintenance listener binds the selected port, serves authentication, status and
the application shell, and rejects workspace REST, MCP and WebSocket activity.
After conversion the ordinary runtime starts on the same port. This avoids
starting watchers, agents, editing rooms or background writers against V1.

The branch also writes migration recovery ownership before copying starts and
checks free disk space for the sibling copy plus conversion overhead. The source
checkpoint must remain unchanged through the swap; external filesystem edits
cause rejection. A committed upgrade retains its original V1 sibling and a
recovery receipt. Those artifacts contain private workspace data and belong on
the same protected filesystem as the workspace.

## Preserve content during an upgrade

The existing reset event describes replacing the content of a workspace. A
storage upgrade preserves that content and needs a narrower refresh contract.

The relevant effects are distributed across
[workspace-reset-files.ts](../../packages/server/src/workspace-reset-files.ts),
[collaboration-epoch.ts](../../packages/server/src/collaboration-epoch.ts),
[share-store.ts](../../packages/server/src/share-store.ts),
[thread-delivery-store.ts](../../packages/server/src/thread-delivery-store.ts),
and the browser's
[workspace-content-epoch.ts](../../apps/web/src/lib/workspace-content-epoch.ts).
Shares are themselves bound to the collaboration epoch, so merely skipping share
deletion while rotating that epoch would still invalidate them.

The implementation distinguishes storage migrations in replacement recovery and
does not emit `workspaceReset` for them. The normal runtime starts after conversion,
which rebuilds its in-memory views while preserving the workspace identity,
collaboration epoch, sharing capabilities, pending deliveries and browser drafts.
Startup and interrupted-migration tests cover this distinction; a real share is
resolved after the automatic upgrade. Content replacement continues to use its
existing reset behavior.

Server shutdown cannot flush edits that exist only in an offline browser. The
upgrade journey must cover a second tab and an offline rich-text client returning
after the upgrade. Preserve compatible collaboration state, or explicitly recover
those edits without silently replaying incompatible state.

## Required product behavior

V2 is the only active product storage format. New workspaces are created as V2.
Existing V1 workspaces are upgraded before editing; declining an upgrade does
not leave an ordinary V1 editing mode. Historical readers and converters remain
necessary for old workspaces, exports, annotations and version history.

The startup gate preserves workspace identity and the collaboration epoch.
It does not emit the content-replacement reset. This is essential for existing
shares, machine-local Yjs state, browser drafts and queued thread deliveries.
If compatibility checks fail, the workspace remains closed to edits and an
owner can retry after addressing the reported problem. Health stays available
for supervisors throughout preparation.

First-run seeding uses normal HTML identity admission. Its private publication
step recreates portable-state manifests for the final Space identity before
publishing the Space. Merely renaming the temporary Space directory leaves V2
state bound to the wrong identity. Starter content does not create edit history.

Old imports and checkpoint restores are verified against their original source
before conversion. They are converted in staging and re-checkpointed before
activation. Independent imports receive a new workspace identity; replacement
imports retain the destination identity while adopting the converted storage
version. Snapshot operation receipts retain the original requested checkpoint,
while cutover verification uses the converted staging tree.

## Additional defects exposed by current-format verification

- Mixed-folder deletion used collaboration capability to decide whether to
  capture a history manifest. File-backed HTML documents use the file storage
  profile without Doc collaboration, so the generated journal contradicted its
  validator. Capture history according to the storage profile, as exact deletion
  already does.
- The V2 sidecar lifecycle treated every base-operation exception as unfinished
  recovery. A fully compensated deletion therefore fenced the workspace and
  dropped queued Yjs frames. A proven compensated operation can retire its
  still-unapplied sidecar preparation and replay those frames. Uncertain failures
  must remain fenced.
- Hosted browser requests acquire a bearer at the gateway. That injected bearer
  must not bypass stale-content protection. Fetch Metadata identifies browser
  requests even with Authorization; explicit supplied content epochs are checked
  for all deployments.
- Lab provenance rewriting must preserve the source storage version. It must not
  label copied V2 files as V1.
- Reading a newly discovered file must return its content before a durable
  annotation identity exists. Conversion already holding the namespace lock must
  not reacquire that lock when checking annotations.
- Moving a document back to its own former path must let the lifecycle planner
  retire its alias. Rejecting every reserved alias prevented that supported move.
- Startup crash recovery needs scoped permission to repair V2 data while ordinary
  writers remain fenced. Requests wait for recovery and remain unavailable if
  repair fails.
- Persisted document data and history must accept existing portable logical
  names ending in source suffixes, such as `Legacy Plan.md`. The stricter naming
  policy belongs to new-document creation, not to existing document owners.
- V2 sidecar preparation must preserve the lifecycle API's ordinary rejection
  result for invalid catalogs and paths, before creating any recovery job.

Tests for ordinary behavior should create documents through managed identity
admission and use the default V2 workspace. Explicit legacy fixtures remain for
historical layout, alias-shadow, version-store and conversion contracts. The
main drawing browser journey must start with normal workspace preparation,
including Welcome content, rather than a prewritten V2 manifest.

## Release and canary sequence

1. Finish focused conversion, recovery, import, collaboration and browser checks;
   resolve behavioral failures before accepting the default change.
2. Run canonical typechecks, policy checks, required tests, relevant full browser
   and Desktop lanes, and packaged installation checks on the final candidate.
3. Build a release from a clean, source-bound commit. Test both fresh installation
   and an isolated legacy workspace containing HTML state, annotations, shares,
   history and queued collaboration state.
4. Rehearse against a readable copy of a real workspace under the service's own
   filesystem identity. A partial census with unreadable directories is not
   evidence that the workspace is ready.
5. Roll out the candidate to one deployment, retain the original checkpoint and
   migration backup, and verify drawing creation, reload, continued editing and
   existing links through the installed product. Expand only after that succeeds.

This branch does not by itself update an already installed server or a hosted
fleet. Source completion, artifact verification and successful installed-product
rollout are separate pieces of delivery.

## Verification that establishes delivery

Strengthen the existing behavioral owners rather than adding a separate test
suite for every patch:

| Owner | Required added evidence |
| --- | --- |
| Workspace and seed tests | Fresh V2 setup completes Welcome; inspecting V1 preserves its manifest until conversion; interrupted seed retries. |
| Replacement and portability tests | Cross-version imports label the actual layout and preserve identity, HTML state/history and drawing source. |
| Migration and live replacement tests | Startup admits no writers before conversion, retains exact rollback data, rejects changed sources, and recovers interrupted preparation/swap/restart. |
| Collaboration/share/delivery coverage | Upgrade preserves links, compatible offline edits and pending work; no blanket content reset; stale clients cannot corrupt post-upgrade content. |
| Browser onboarding/drawing journey | Start through normal setup, or open V1 and upgrade through the product, then create/draw/save/reopen; no fixture-only V2 admission. |
| Packaged and deployment checks | Installed CLI, Desktop host reconnect and Cloud gateway/provisioner use the same supported operation. |

Run focused checks while implementing and the final candidate checks in
[development.md](../development.md). Because storage and shared runtime contracts
change, the relevant full browser/Desktop and package lanes remain necessary.

## Evidence collected in this investigation

Using Bun 1.3.14 with the frozen lockfile:

```sh
bun run scripts/testing/run.ts required \
  --test-file packages/server/src/document-storage-migration-v2.test.ts \
  --test-file packages/server/src/workspace-replacement-lifecycle.test.ts \
  --test-file packages/server/src/workspace.test.ts

bun run scripts/testing/run.ts full --suite web-browser \
  --test-file apps/web/e2e/drawing.browser.ts
```

The focused server run passed 45 tests, with no failures or skips. The existing
headless Chromium drawing journey passed without retries. These prove the current
engine and prepared V2 drawing path; they do not prove the proposed product upgrade.

Temporary probes independently reproduced the fresh V2 seed failure and both
import layout mismatches. They called the real seed and replacement functions in
disposable workspaces; no production implementation was patched for the probes.

For the first real upgrade, confirm the workspace/runtime pairing and collect a complete census under
the service identity including relevant application state, rehearse on an isolated
copy, and resolve actual diagnostics without deleting or excluding user data by
default. Then exercise the supported upgrade flow as the canary. Do not hand-edit
the live manifest or weaken the drawing gate to obtain access early.

## Candidate verification

Application and lab typechecks and the canonical test-policy check pass.
Focused HTTP tests cover mandatory startup conversion, blocked-upgrade retry,
retained rollback data, stable collaboration identity and preservation of a
working share. Replacement tests read HTML source and runtime state after imports
from both storage versions.

A visible Chromium session exercised a synthetic V1 workspace with a namespace
conflict. The gate remained visible until repair and owner retry, then opened the
upgraded workspace with its existing note. The ordinary New menu created a drawing;
ink persisted and remained after reload. Full browser, server, CLI, Desktop and
packaged verification are tracked separately before release.
