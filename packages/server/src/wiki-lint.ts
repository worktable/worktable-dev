// ============================================================
// Mechanical wiki lint — deterministic rules, idempotent annotations
// ============================================================
//
// Structural health checks over a space's docs: broken doc links,
// orphan docs, and docs over the length budget. Deterministic code
// only — semantic lint (contradictions, staleness-of-meaning) is
// judgment work and belongs to an unprivileged agent over MCP,
// never in this package (architecture seam: no privileged agents
// in core). Staleness is deliberately NOT a lint rule: it surfaces
// as ambient freshness signals, not as tasks.
//
// Findings are annotations, not a report doc: they anchor to the
// offending doc, dedupe via idempotencyKey, reopen when a fixed
// rule breaks again, and auto-resolve when the rule passes — so
// the open set always mirrors reality and never piles up.

import type { Annotation, AnnotationAuthor } from "@worktable/types"
import {
  createAnnotation,
  listAnnotations,
  resolveAnnotation,
  updateAnnotation,
} from "./annotation-store.ts"
import { getSpaceLinkGraph } from "./link-graph.ts"
import {
  getSpaceArchiveInfo,
  listDocsDetailed,
  listSpaces,
  readDoc,
  readSpace,
} from "./store.ts"
import { onDocContentChanged } from "./content-events.ts"
import { getWikiConfig } from "./wiki-config.ts"
import { wsManager } from "./ws.ts"

export type LintRuleId = "broken-links" | "orphan-doc" | "doc-too-long"

export const LINT_AUTHOR: AnnotationAuthor = {
  type: "system",
  id: "worktable-lint",
  name: "Worktable Lint",
}

export interface LintFinding {
  rule: LintRuleId
  docPath: string
  title: string
  body: string
}

export function lintIdempotencyKey(rule: LintRuleId, docPath: string): string {
  return `${rule}:${docPath}`
}

// ── Evaluation (pure given workspace state) ──────────────────

export async function evaluateSpaceLint(
  spaceId: string
): Promise<LintFinding[]> {
  const space = await readSpace(spaceId)
  if (!space.data) return []
  const cfg = getWikiConfig(space.data)
  const docs = await listDocsDetailed(spaceId, { includeArchived: false })
  const activePaths = new Set(docs.map((d) => d.path))
  const graph = await getSpaceLinkGraph(spaceId)
  const findings: LintFinding[] = []

  // broken-links: one finding per doc, listing every missing target.
  const brokenByDoc = new Map<string, string[]>()
  for (const broken of graph.broken) {
    if (!activePaths.has(broken.docPath)) continue
    const targets = brokenByDoc.get(broken.docPath) ?? []
    targets.push(broken.resolvedPath)
    brokenByDoc.set(broken.docPath, targets)
  }
  for (const [docPath, targets] of brokenByDoc) {
    findings.push({
      rule: "broken-links",
      docPath,
      title: "Broken links",
      body: `Links to ${targets.length === 1 ? "a doc that does not exist" : `${targets.length} docs that do not exist`}: ${targets.map((t) => `/${t}`).join(", ")}. Create the missing docs or fix the links.`,
    })
  }

  // orphan-doc: only meaningful in spaces that use links at all — in a space
  // with zero resolved links, every doc is technically an orphan and flagging
  // them would flood the review surface with noise.
  if (graph.inbound.size > 0 && activePaths.size > 1) {
    for (const docPath of graph.orphans) {
      if (!activePaths.has(docPath)) continue
      findings.push({
        rule: "orphan-doc",
        docPath,
        title: "Orphan doc",
        body: "No other doc links here. Link it from a related doc so it stays findable, or archive it if it is no longer needed.",
      })
    }
  }

  // doc-too-long: lines for markdown, blocks for BlockNote.
  for (const doc of docs) {
    if (doc.storedAs === "md") {
      const result = await readDoc(spaceId, doc.path)
      if (typeof result.data !== "string") continue
      const lines = result.data.split("\n").length
      if (lines > cfg.docLengthBudgetLines) {
        findings.push({
          rule: "doc-too-long",
          docPath: doc.path,
          title: "Doc over length budget",
          body: `${lines} lines (budget ${cfg.docLengthBudgetLines}). Split it into focused docs and link the parts by path.`,
        })
      }
    } else if (
      typeof doc.blockCount === "number" &&
      doc.blockCount > cfg.docLengthBudgetBlocks
    ) {
      findings.push({
        rule: "doc-too-long",
        docPath: doc.path,
        title: "Doc over length budget",
        body: `${doc.blockCount} blocks (budget ${cfg.docLengthBudgetBlocks}). Split it into focused docs and link the parts by path.`,
      })
    }
  }

  return findings
}

// ── Reconciliation (create / reopen / update / auto-resolve) ─

function broadcast(
  spaceId: string,
  annotation: Annotation,
  event: "created" | "updated" | "resolved"
): void {
  wsManager.broadcast(spaceId, {
    type: "annotation_update",
    spaceId,
    data: { annotationId: annotation.id, annotation, event },
  })
}

export async function applyLintFindings(
  spaceId: string,
  findings: LintFinding[]
): Promise<void> {
  // All lint annotations in the space, resolved included — the idempotency
  // dedupe in createAnnotation would silently return a resolved annotation,
  // so reopening must be explicit.
  const existing = await listAnnotations(spaceId, {
    labels: ["lint"],
    includeResolved: true,
    limit: 10_000,
  })
  const byKey = new Map<string, Annotation>()
  for (const annotation of existing.annotations) {
    if (annotation.idempotencyKey)
      byKey.set(annotation.idempotencyKey, annotation)
  }

  const currentKeys = new Set<string>()
  for (const finding of findings) {
    const key = lintIdempotencyKey(finding.rule, finding.docPath)
    currentKeys.add(key)
    const found = byKey.get(key)

    if (!found) {
      const result = await createAnnotation(spaceId, {
        target: { type: "doc", docPath: finding.docPath },
        category: "comment",
        title: finding.title,
        body: finding.body,
        author: LINT_AUTHOR,
        labels: ["lint", `lint:${finding.rule}`],
        idempotencyKey: key,
      })
      if (result.created) broadcast(spaceId, result.annotation, "created")
      continue
    }

    if (found.status === "resolved") {
      const reopened = await updateAnnotation(
        spaceId,
        found.id,
        {
          status: "open",
          body: finding.body,
        },
        LINT_AUTHOR.id
      )
      broadcast(spaceId, reopened, "updated")
    } else if (found.body !== finding.body) {
      // Body-diff guard: update only on real change so re-runs never churn
      // sidecar files or spam annotation_update events.
      const updated = await updateAnnotation(
        spaceId,
        found.id,
        { body: finding.body },
        LINT_AUTHOR.id
      )
      broadcast(spaceId, updated, "updated")
    }
  }

  // Auto-resolve open lint findings whose rule now passes.
  for (const annotation of existing.annotations) {
    if (annotation.status !== "open") continue
    if (
      !annotation.idempotencyKey ||
      currentKeys.has(annotation.idempotencyKey)
    )
      continue
    if (annotation.author.id !== LINT_AUTHOR.id) continue
    const resolved = await resolveAnnotation(
      spaceId,
      annotation.id,
      "Rule passes",
      LINT_AUTHOR.id
    )
    broadcast(spaceId, resolved, "resolved")
  }
}

export async function runSpaceLint(spaceId: string): Promise<void> {
  await applyLintFindings(spaceId, await evaluateSpaceLint(spaceId))
}

// ── Scheduling ────────────────────────────────────────────────

const DOC_CHANGE_DEBOUNCE_MS = 2_000
/** A steady write stream must not starve lint forever. */
const MAX_WAIT_MS = 15_000
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000

export class LintScheduler {
  private readonly pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; firstChangeAt: number }
  >()
  private readonly running = new Set<Promise<void>>()
  private readonly runner: (spaceId: string) => Promise<void>
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly now: () => number
  private readonly schedule: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>
  private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void
  private acceptingChanges: boolean

  constructor(opts?: {
    runner?: (spaceId: string) => Promise<void>
    debounceMs?: number
    maxWaitMs?: number
    active?: boolean
    now?: () => number
    schedule?: (
      callback: () => void,
      delayMs: number
    ) => ReturnType<typeof setTimeout>
    cancel?: (timer: ReturnType<typeof setTimeout>) => void
  }) {
    this.runner = opts?.runner ?? runSpaceLint
    this.debounceMs = opts?.debounceMs ?? DOC_CHANGE_DEBOUNCE_MS
    this.maxWaitMs = opts?.maxWaitMs ?? MAX_WAIT_MS
    this.now = opts?.now ?? Date.now
    this.schedule = opts?.schedule ?? setTimeout
    this.cancel = opts?.cancel ?? clearTimeout
    this.acceptingChanges = opts?.active ?? true
  }

  /** Coalesced per-space trailing debounce; all rules are space-scoped. */
  noteDocChanged(spaceId: string, _docPath?: string): void {
    if (!this.acceptingChanges) return
    const entry = this.pending.get(spaceId)
    const now = this.now()
    const firstChangeAt = entry?.firstChangeAt ?? now
    if (entry) this.cancel(entry.timer)

    if (now - firstChangeAt >= this.maxWaitMs) {
      this.pending.delete(spaceId)
      void this.run(spaceId)
      return
    }

    const timer = this.schedule(() => {
      this.pending.delete(spaceId)
      void this.run(spaceId)
    }, this.debounceMs)
    this.pending.set(spaceId, { timer, firstChangeAt })
  }

  async sweepAll(): Promise<void> {
    if (!this.acceptingChanges) return
    for (const space of await listSpaces()) {
      if (!this.acceptingChanges) return
      if (getSpaceArchiveInfo(space)) continue
      await this.run(space.id)
    }
  }

  async stop(): Promise<void> {
    this.acceptingChanges = false
    for (const entry of this.pending.values()) this.cancel(entry.timer)
    this.pending.clear()
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running])
    }
  }

  /** Re-open the singleton for a newly started server lifecycle. */
  start(): void {
    this.acceptingChanges = true
  }

  private async run(spaceId: string): Promise<void> {
    const task = this.runTracked(spaceId)
    this.running.add(task)
    try {
      await task
    } finally {
      this.running.delete(task)
    }
  }

  private async runTracked(spaceId: string): Promise<void> {
    try {
      await this.runner(spaceId)
    } catch (err) {
      console.error(`[wiki-lint] lint run failed for space ${spaceId}:`, err)
    }
  }
}

// The process singleton is dormant until startServer wires its event sources.
// Standalone LintScheduler instances remain active by default for direct use.
export const lintScheduler = new LintScheduler({ active: false })

/**
 * Wire the scheduler to change notifications and start the periodic sweep.
 * Called from startServer only — deliberately NOT a module side effect, so
 * importing this module (tests, tools) never starts background work.
 */
export function startLintScheduler(): () => Promise<void> {
  lintScheduler.start()
  const unsubscribe = onDocContentChanged((spaceId, docPath) => {
    lintScheduler.noteDocChanged(spaceId, docPath)
  })

  const bootKick = setTimeout(() => {
    void lintScheduler.sweepAll()
  }, 30_000)
  const interval = setInterval(() => {
    void lintScheduler.sweepAll()
  }, SWEEP_INTERVAL_MS)

  return async () => {
    unsubscribe()
    clearTimeout(bootKick)
    clearInterval(interval)
    await lintScheduler.stop()
  }
}
