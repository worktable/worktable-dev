# Engineering archive

These reports preserve investigations, decisions, failed experiments, and measured
results. They describe their recorded source and environment, not the current
product. Use [Development](../development.md) for maintained checks and the
[product docs](https://docs.worktable.dev/) for supported behavior.

## Investigations

| Investigation | Date and source | Status and reading order |
| --- | --- | --- |
| Document loading | September 2026; implementation merged in `3ecce7f` on September 22. Individual reports retain their experimental checkpoint IDs. | Begin with [results](document-loading-results.md) and [layout follow-up](document-opening-layout.md). The initial findings and intermediate proposals are superseded where these reports say so. Recorded editing and interaction targets remained unmet. |
| Drawing storage | September 30, 2026; baseline `9074c80`, implementation `7bd89cd`. | [Rollout investigation](drawing-documents-v2-rollout.md) records the baseline gaps and candidate work. V2 is now the active format; new workspaces use V2 and legacy workspaces upgrade before normal operation. Use [workspace storage](https://docs.worktable.dev/reference/workspace-files/) for current behavior. |
| Visual previews | October 1, 2026; implementation merged in `56dc83f` and released with 0.1.14. | The [proposal](visual-previews-plan.md) is superseded by the [implementation report](visual-previews-implementation.md). Its environment-specific verification limits remain historical evidence. Current packaging instructions are in [Building](../building.md). |

Merge commits identify the integrated work. They do not retroactively establish
which candidate produced each local measurement. Where an exact experimental
source was not retained, the report cannot be reproduced as an exact benchmark.

## Loading history

1. [Initial investigation](document-loading.md): server and renderer paths, with corrected scope.
2. [Startup investigation](document-loading-second-pass.md): full-page startup and delivery.
3. [Initial fixes](document-loading-fixes.md): implementation and controlled comparisons.
4. [Remaining bottlenecks](document-loading-critical-follow-up.md): reader, editor, and shell experiments.
5. [Timing breakdown](document-loading-timing-breakdown.md): one large-document sample and a separate diagnostic trace.
6. [Solution research](document-loading-solutions-research.md): options and compatibility costs.
7. [Implementation log](document-loading-implementation-progress.md): all stages, including rejected changes and failures.
8. [Final results](document-loading-results.md): paired comparisons and outstanding limits.
9. [Layout follow-up](document-opening-layout.md): preview-to-editor geometry and status.

## Evidence

JSON files and screenshots beside each report retain the recorded observations.
Timings, byte counts, failures, and exclusions have not been normalized into new
results. Screenshots show synthetic fixtures and historical UI.

Original LAN host addresses have been replaced with `audit-host.example.test` in
retained evidence, preserving ports and request paths. The replacement is a
placeholder, not a live review service. Temporary review links and conversation
references were removed. Non-reproducible checks of personal workspaces are
excluded; the retained layout evidence comes from synthetic fixtures.

## Reproduction

[Loading experiments](document-loading-experiments/README.md) documents historical
harnesses. They are not maintained acceptance tests. Some transforms depend on
BlockNote 0.51.4 and old source structure and must not be applied to current code.
Use the appropriate historical checkout in an isolated workspace when studying
them. Recorded local `.local-dev/` and `/tmp/` outputs are not distributed here.

## Follow-up work

The loading reports leave three questions open: current cold editing and input
latency, performance in deployed environments, and Firefox/Safari behavior.
Re-measure the current product before choosing another optimization; the old
figures are not current regressions or service guarantees. Visual-preview target
coverage likewise belongs to the current release checks, not this archive.
