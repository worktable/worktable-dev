import { expect, test } from "bun:test"
import { addedLintErrors, type LintMessage } from "./lint-changed.ts"

test("fails only on lint errors a change adds", () => {
  const error = (ruleId: string | null, line: number): LintMessage => ({
    ruleId,
    severity: 2,
    line,
    column: 1,
    message: `${ruleId ?? "parse"} at ${line}`,
  })
  const warning = { ...error("no-console", 9), severity: 1 }
  const debt = [error("no-explicit-any", 3), error("prefer-const", 7)]

  // Existing debt moving with an edit, and new warnings, pass.
  expect(
    addedLintErrors(debt, [
      error("no-explicit-any", 5),
      error("prefer-const", 8),
      warning,
    ])
  ).toEqual([])
  // One more error of a rule fails and lists that rule's errors.
  expect(
    addedLintErrors(debt, [...debt, error("no-explicit-any", 12)])
  ).toEqual([
    {
      rule: "no-explicit-any",
      before: 1,
      after: 2,
      messages: [error("no-explicit-any", 3), error("no-explicit-any", 12)],
    },
  ])
  // Every error in a new file is new, including a parse failure.
  expect(addedLintErrors(null, [error(null, 1), warning])).toEqual([
    { rule: "parse", before: 0, after: 1, messages: [error(null, 1)] },
  ])
})
