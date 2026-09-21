/**
 * Global test isolation preload (wired via the repo-root bunfig.toml `[test]
 * preload`). Bun runs every test FILE in one shared process, so module-level
 * singletons, timers, and path overrides leak across files and make the suite
 * order-dependent (a release-blocking flake: a yjs persist timer from one file
 * firing during another wrote a stray `docs.meta.json` into a fixture's temp
 * root, breaking the determinism gate; stale path overrides broke exposed-server
 * CORS/WS tests).
 *
 * Resetting this shared state after EVERY test guarantees each test starts clean
 * regardless of which earlier test forgot to clean up. Each is safe: no test
 * sets a path override in `beforeAll` (they use `beforeEach`), and yjsManager has
 * no live docs at rest, so `shutdown()` is a no-op outside the files that use it.
 */
import { afterEach } from "bun:test";
import { yjsManager } from "./src/yjs-manager.ts";
import { setWorkspaceRootOverride } from "./src/workspace.ts";
import { setAppDirOverride } from "./src/app-storage.ts";
import { lintScheduler } from "./src/wiki-lint.ts";
import { resetRecordDiagnosticsForTests } from "./src/record-store.ts";
import { recordIndex } from "./src/record-index.ts";
import { invalidateServerSettingsCache } from "./src/settings-store.ts";
import { drainWorkspaceChanges } from "./src/workspace-events.ts";

// Disable the server's fire-and-forget starter seed for the whole test process:
// it is un-awaited, so it races each test's afterEach dir cleanup (ENOENT noise
// that can also leak into a sibling file). seed.test.ts exercises the seed
// directly, so nothing is left uncovered.
process.env["WORKTABLE_SKIP_STARTER_SEED"] = "1";

// Same rationale for the background lint scheduler: startServer would register
// a doc-change listener + sweep timers whose debounced lint runs race other
// tests' temp workspaces. wiki-lint.test.ts drives lint directly, so nothing
// is left uncovered.
process.env["WORKTABLE_SKIP_LINT_SWEEP"] = "1";

// And the retention timers: startServer's 30s boot sweep + daily interval would
// outlive a test's temp workspace overrides and could prune a LATER test's
// versions (or the default workspace) mid-suite. version-retention.test.ts
// drives sweeps directly, so nothing is left uncovered.
process.env["WORKTABLE_SKIP_RETENTION_SWEEP"] = "1";

// Production drift recovery is exercised directly in projection tests; do not
// attach its five-minute timer to disposable test workspaces.
process.env["WORKTABLE_SKIP_RECORD_RECONCILE_SWEEP"] = "1";

afterEach(async () => {
  await yjsManager.shutdown();
  // Workspace handlers and the record projection read through the provider at
  // execution time. Drain queued work before switching either provider back to
  // the developer's real installation or deleting a test's temp directories.
  await drainWorkspaceChanges();
  await recordIndex.whenIdle();
  // Settings are cached independently of the app-storage path. A test that
  // changes the app-dir override can otherwise leave the previous install's
  // public URL, auth posture, or retention policy active for the next test.
  invalidateServerSettingsCache();
  setWorkspaceRootOverride(null);
  setAppDirOverride(null);
  await lintScheduler.stop();
  // Record diagnostics are cached per space/collection id, which repeat across
  // tests' temp workspaces.
  resetRecordDiagnosticsForTests();
  // The record index holds an open SQLite handle under the (temp) app dir and
  // subscribes to record events; both must not leak into the next test.
  recordIndex.stop();
});
