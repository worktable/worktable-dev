import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  FIRST_RUN_REVIEW,
  FIXTURE_REVIEWS,
  fixtureReviewSlugs,
  validateFixtureReview,
} from "./fixture-review.ts"

describe("lab fixture review catalog", () => {
  test("covers the exact fixture inventory with live references", () => {
    expect(Object.keys(FIXTURE_REVIEWS).sort()).toEqual(
      [...fixtureReviewSlugs()].sort()
    )
    for (const review of Object.values(FIXTURE_REVIEWS)) {
      expect(validateFixtureReview(review)).toEqual([])
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
})
