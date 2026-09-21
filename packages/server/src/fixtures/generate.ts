/**
 * Fixture generation + verification (pure functions; no process side effects, so this
 * is importable by tests — unlike cli.ts, whose entrypoint runs on import).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FIXTURES, getFixture, type FixtureDef } from "./defs.ts";
import { FixtureBuilder } from "./harness.ts";
import { setWorkspaceRootOverride } from "../workspace.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
export const FIXTURES_DIR = join(REPO_ROOT, "fixtures", "workspaces");

/**
 * Generate a fixture into `outDir`. Builds into a sibling staging dir and swaps into
 * place ONLY on success, so a build/validation/I/O failure never wipes a committed
 * fixture (an existing `outDir` is left untouched on error).
 */
export async function generateInto(def: FixtureDef, outDir: string): Promise<void> {
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, `.fixgen-${def.name}-`));

  // 1. Build into staging. On any failure, drop staging and leave outDir untouched.
  try {
    const b = new FixtureBuilder(staging);
    await def.build(b);
    await b.finalize(def.workspace);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  } finally {
    // Always clear the module-level override so one fixture never leaks into the next.
    setWorkspaceRootOverride(null);
  }

  // 2. Swap into place crash-safely. renameSync cannot overwrite a non-empty dir, so
  //    move any existing tree ASIDE first, then move staging in; if that swap fails,
  //    restore the original. Neither the committed fixture nor the new build is ever
  //    left deleted by a failed rename.
  const hadExisting = existsSync(outDir);
  const backup = join(parent, `.fixbak-${def.name}-${process.pid}-${Date.now()}`);
  if (hadExisting) renameSync(outDir, backup);
  try {
    renameSync(staging, outDir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    if (hadExisting && !existsSync(outDir)) renameSync(backup, outDir); // restore the original
    throw err;
  }
  if (hadExisting) rmSync(backup, { recursive: true, force: true });
}

function selected(onlyName?: string): FixtureDef[] {
  if (onlyName) return [getFixture(onlyName)];
  return Object.values(FIXTURES);
}

export async function generate(onlyName?: string): Promise<number> {
  for (const def of selected(onlyName)) {
    await generateInto(def, join(FIXTURES_DIR, def.name));
    console.log(`[fixtures] generated ${def.name} -> fixtures/workspaces/${def.name}`);
  }
  return 0;
}

export async function verify(onlyName?: string): Promise<number> {
  let drift = 0;
  for (const def of selected(onlyName)) {
    const committed = join(FIXTURES_DIR, def.name);
    if (!existsSync(committed)) {
      console.error(`[fixtures] MISSING committed fixture: ${def.name} (run fixtures:generate)`);
      drift++;
      continue;
    }
    const tmp = mkdtempSync(join(tmpdir(), `wt-fixverify-${def.name}-`));
    try {
      await generateInto(def, tmp);
      try {
        execFileSync("diff", ["-r", committed, tmp], { stdio: "pipe" });
        console.log(`[fixtures] ${def.name}: deterministic ✓`);
      } catch (err) {
        const e = err as { status?: number; code?: string; stdout?: Buffer | string };
        if (e.status === 1) {
          // diff exit code 1 = genuine byte differences -> real drift.
          console.error(`[fixtures] DRIFT in ${def.name}:\n${e.stdout?.toString() ?? "(diff produced output)"}`);
          drift++;
        } else {
          // diff missing (ENOENT) or errored (status >= 2) = a tool/env failure, NOT drift.
          // Surface it instead of misreporting a byte mismatch.
          throw new Error(`[fixtures] cannot verify ${def.name}: diff failed (${e.code ?? `exit ${e.status}`})`);
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (drift > 0) {
    console.error(`[fixtures] ${drift} fixture(s) drifted — regenerate with: bun run fixtures:generate`);
    return 1;
  }
  console.log("[fixtures] all fixtures deterministic ✓");
  return 0;
}
