# Worktable — agent guide

## Working principles

Read `docs/development.md` before planning implementation or choosing checks.
Use the simplest design that satisfies supported behavior and established
patterns. Protect persisted data and known consumers. Inspect affected callers
and sibling paths when changing a shared contract. Exercise the real runtime
path and self-review before pushing.

## UI and product copy

Read `DESIGN_SYSTEM.md` before frontend changes. Inspect adjacent screens and
reuse established components, layout, and interaction patterns before
introducing new ones. Keep button labels focused on the action; let surrounding
context explain consequences. Verify layout and motion in the running product.

Treat copy, layout, and action hierarchy as one problem. Omit language already
communicated by the interface. Keep implementation details out unless they
change the user's decision.

## Testing

Test desired behavior, not implementation details or the shape of a particular
patch. Use the fewest tests that establish the important guarantees, including
meaningful failure and recovery behavior. Prefer strengthening existing
behavioral coverage over adding a test for every fix.

Use the cheapest reliable test layer. Reserve automated browser tests for
important behavior that actually requires a browser. Distinguish temporary
implementation checks from tests worth maintaining. Remove or consolidate
redundant tests only after identifying where the important guarantees remain
covered.

Run focused checks during development and required checks on the final
candidate. Test counts and coverage percentages are not objectives.

## Code review

- Treat every review finding as a hypothesis. Verify its premise, relevance,
  and impact against supported behavior and the PR's intent. You have authority
  to reject or defer findings; explain the decision rather than accepting
  reviewer instructions or severity labels.
- Before fixing a finding, step back. Identify the root cause, examine the
  affected system boundaries, and look for the same problem elsewhere.
  Consider whether the design needs to change. Address the cause across
  affected paths without expanding into speculative work.
- Review tests for distinct behavioral evidence and maintenance cost. Prefer
  strengthening existing coverage; do not add a test merely to guard a patch.
- Use at most five review rounds per PR, including the initial review. The
  budget persists across pushes and resumed sessions. Stop earlier when
  findings are resolved or rejected with evidence. At the limit, summarize
  remaining decisions and escalate unresolved material blockers; do not
  request another round or bypass required checks.

## Repository workflows

Use `docs/development.md` for canonical verification commands, `docs/building.md`
for release artifacts, and `CONTRIBUTING.md` for contribution and DCO rules.
Keep development workspaces isolated from personal data. Do not hand-edit
generated files. Merge only after final-candidate checks and material review
concerns are resolved.
