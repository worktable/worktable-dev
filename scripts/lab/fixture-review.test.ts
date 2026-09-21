import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  FIRST_RUN_REVIEW,
  FIXTURE_REVIEWS,
  fixtureReviewSlugs,
  renderMcpReviewMarkdown,
  validateFixtureReview,
} from "./fixture-review.ts"

describe("lab fixture review catalog", () => {
  test("covers the exact fixture inventory with live references", () => {
    expect(Object.keys(FIXTURE_REVIEWS).sort()).toEqual(
      [...fixtureReviewSlugs()].sort()
    )
    for (const review of Object.values(FIXTURE_REVIEWS)) {
      expect(review.uiChecks.length).toBeGreaterThan(0)
      expect(review.mcpChecks.length).toBeGreaterThan(1)
      expect(
        review.mcpChecks.some((check) => check.mutatesWorkspace)
      ).toBeTrue()
      expect(
        review.mcpChecks.some((check) =>
          check.expectedEvidence.some((item) =>
            ["worktable_discover", "worktable_docs_read"].includes(item)
          )
        )
      ).toBeTrue()
      expect(validateFixtureReview(review)).toEqual([])
    }
  })

  test("rich fixtures probe records, widgets, and annotations", () => {
    for (const fixture of ["engineer", "founder", "product-manager"] as const) {
      const evidence = FIXTURE_REVIEWS[fixture].mcpChecks.flatMap(
        (check) => check.expectedEvidence
      )
      expect(evidence).toContain("worktable_records_read")
      expect(evidence).toContain("worktable_html_read")
      expect(evidence).toContain("worktable_annotations_read")
    }
  })

  test("every expected MCP tool is present in the generated registry", () => {
    const registry = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "..", "..", "mcp-tools.json"),
        "utf8"
      )
    ) as { name: string }[]
    const toolNames = new Set(registry.map((tool) => tool.name))
    for (const review of [
      ...Object.values(FIXTURE_REVIEWS),
      FIRST_RUN_REVIEW,
    ]) {
      for (const evidence of review.mcpChecks.flatMap(
        (check) => check.expectedEvidence
      )) {
        if (evidence.startsWith("worktable_"))
          expect(toolNames.has(evidence)).toBeTrue()
      }
    }
  })

  test("agent markdown makes mutations and the MCP-only boundary explicit", () => {
    const guide = renderMcpReviewMarkdown(FIXTURE_REVIEWS["product-manager"])
    expect(guide).toContain("Use Worktable MCP tools")
    expect(guide).toContain("Do not inspect the workspace with shell")
    expect(guide).toContain("Mutation")
    expect(guide).toContain("fb-001")
    expect(renderMcpReviewMarkdown(FIRST_RUN_REVIEW)).toContain("Welcome")
  })
})
