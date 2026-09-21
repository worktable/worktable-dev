#!/usr/bin/env bun
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import budgets from "./budgets.json"
import { isBareSleepLine } from "./policy-rules.ts"
import {
  isRecognizedTestFile,
  listRepositoryFiles,
  repositoryRoot,
  testSuites,
} from "./suites.ts"

interface Finding {
  severity: "error" | "warning"
  message: string
}

const files = listRepositoryFiles()
const tests = files.filter(isRecognizedTestFile)
const testSupportFiles = files.filter(
  (path) =>
    /(?:^|\/)e2e\/.+\.[cm]?[jt]sx?$/.test(path) ||
    /(?:test|e2e)-(?:harness|runner|worker)\.[cm]?[jt]sx?$/.test(path)
)
const testCodeFiles = [...new Set([...tests, ...testSupportFiles])].sort()
const findings: Finding[] = []

for (const path of tests) {
  const owners = testSuites.filter((suite) => suite.owns(path))
  if (owners.length !== 1) {
    findings.push({
      severity: "error",
      message:
        owners.length === 0
          ? `${path} has no canonical suite owner`
          : `${path} has multiple canonical owners: ${owners
              .map((suite) => suite.id)
              .join(", ")}`,
    })
  }
}

const bypasses = [
  /\bbun\s+(?:(?:--config(?:=|\s+)\S+)\s+)?test(?:\s|$)/m,
  /bun run --cwd (?:control-plane|gateway) test(?::worker)?(?:\s|$)/m,
  /go -C infra\/github-runner test/m,
]
for (const path of files.filter(
  (file) =>
    file.startsWith(".github/workflows/") && /\.(?:yml|yaml)$/.test(file)
)) {
  const source = await readFile(resolve(repositoryRoot, path), "utf8")
  if (bypasses.some((pattern) => pattern.test(source))) {
    findings.push({
      severity: "error",
      message: `${path} bypasses canonical test commands`,
    })
  }
}

for (const path of files.filter((file) => file.endsWith("package.json"))) {
  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, path), "utf8")
  ) as { scripts?: Record<string, string> }
  const testCommand = manifest.scripts?.["test"]
  // The OpenClaw adapter is exported as a standalone public package. Its
  // package-local command must work outside this monorepo; repository CI still
  // owns the same files through the canonical bun-standard lane.
  const isPortableOpenClawPackage =
    path === "packages/openclaw-plugin/package.json" &&
    testCommand === "bun test"
  if (
    testCommand &&
    !testCommand.includes("scripts/testing/run.ts") &&
    testCommand !== "bun run test:required" &&
    !isPortableOpenClawPackage
  ) {
    findings.push({
      severity: "error",
      message: `${path} has a non-canonical package test script`,
    })
  }
}

const [rootBunfig, serverBunfig, standardBunfig] = await Promise.all([
  readFile(resolve(repositoryRoot, "bunfig.toml"), "utf8"),
  readFile(resolve(repositoryRoot, "packages/server/bunfig.toml"), "utf8"),
  readFile(
    resolve(repositoryRoot, "scripts/testing/bunfig.standard.toml"),
    "utf8"
  ),
])

const preloadEntries = (source: string): string[] => {
  const arrayBody = source.match(/preload\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? ""
  const uncommented = arrayBody
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n")
  return [...uncommented.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
}

const hasOrderedPreloads = (
  entries: string[],
  sandbox: string,
  setup: string
): boolean => {
  const sandboxIndex = entries.indexOf(sandbox)
  const setupIndex = entries.indexOf(setup)
  return sandboxIndex >= 0 && setupIndex > sandboxIndex
}

const rootPreloads = preloadEntries(rootBunfig)
const serverPreloads = preloadEntries(serverBunfig)
if (
  !hasOrderedPreloads(
    rootPreloads,
    "./packages/server/test-sandbox.ts",
    "./packages/server/test-setup.ts"
  ) ||
  !hasOrderedPreloads(
    serverPreloads,
    "./test-sandbox.ts",
    "./test-setup.ts"
  )
) {
  findings.push({
    severity: "error",
    message: "the root/server safe Bun configurations lost the server preload",
  })
}
if (
  !standardBunfig.includes("[test]") ||
  standardBunfig.includes("test-setup")
) {
  findings.push({
    severity: "error",
    message: "the canonical standard Bun configuration loads a server preload",
  })
}

const boundaryDirectory =
  /^(?:apps\/cli\/src|packages\/server\/src|control-plane\/tests\/boundaries|apps\/web\/e2e|apps\/landing-cloud\/e2e|apps\/desktop\/(?:scripts|e2e)|scripts)\//
for (const path of tests) {
  const source = await readFile(resolve(repositoryRoot, path), "utf8")
  const subprocessOrBrowser =
    /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/.test(source) ||
    /from ["']@playwright\/test["']/.test(source)
  if (subprocessOrBrowser && !boundaryDirectory.test(path)) {
    findings.push({
      severity: "error",
      message: `${path} contains a subprocess/browser test outside a boundary directory`,
    })
  }
  if (/\b(?:describe|it|test)\.(?:skip|todo)\s*\(/.test(source)) {
    const owner = testSuites.find((suite) => suite.owns(path))
    if (
      owner &&
      !owner.profiles.includes("full") &&
      !owner.profiles.includes("host")
    ) {
      findings.push({
        severity: "error",
        message: `${path} has a default-skipped test without an explicit full/host lane`,
      })
    }
  }

  const sourceLines = source.split("\n")
  const lines = sourceLines.length
  if (lines > budgets.fileWarningLines) {
    findings.push({
      severity: "warning",
      message: `${path} is ${lines.toLocaleString()} lines (warning threshold ${budgets.fileWarningLines.toLocaleString()})`,
    })
  }
}

for (const path of testCodeFiles) {
  const source = await readFile(resolve(repositoryRoot, path), "utf8")
  const sourceLines = source.split("\n")
  const bareSleeps = sourceLines.filter((_, index) =>
    isBareSleepLine(sourceLines, index)
  ).length
  const baseline =
    budgets.bareSleepBaseline[path as keyof typeof budgets.bareSleepBaseline] ??
    0
  if (bareSleeps > baseline) {
    findings.push({
      severity: "error",
      message: `${path} adds bare sleeps (${bareSleeps}; baseline ${baseline})`,
    })
  }
}

const errors = findings.filter((finding) => finding.severity === "error")
const warnings = findings.filter((finding) => finding.severity === "warning")
console.log(
  `Test policy checked ${tests.length} files across ${testSuites.length} lanes.`
)
for (const finding of [...errors, ...warnings]) {
  console.log(`${finding.severity.toUpperCase()}: ${finding.message}`)
}
if (errors.length > 0) process.exit(1)
