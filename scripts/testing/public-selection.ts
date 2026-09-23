import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { publicTestSuites } from "./public-suites.ts"
import { repositoryDocsOnly } from "../repository-docs.ts"

const allSuites = publicTestSuites.map((suite) => suite.id)
const required = publicTestSuites
  .filter((suite) => suite.profiles.includes("required"))
  .map((suite) => suite.id)

export function productDocsOnly(paths: string[]): boolean {
  return (
    paths.some((path) => path.startsWith("apps/docs/")) &&
    paths.every(
      (path) => path.startsWith("apps/docs/") || repositoryDocsOnly([path])
    )
  )
}

// Narrow only independent public surfaces. Shared contracts, server protocols,
// build inputs, new packages and unknown paths retain every portable lane.
export function selectPublicSuiteIds(paths: string[]): string[] {
  if (paths.length === 0) return [...allSuites]
  if (productDocsOnly(paths)) return []
  const selected = new Set(required)
  for (const path of paths) {
    if (path.startsWith("apps/web/")) selected.add("web-browser")
    else if (path.startsWith("apps/desktop/")) {
      selected.add("desktop-contracts")
      selected.add("desktop-browser")
    } else if (path.startsWith("packages/ui/")) {
      selected.add("web-browser")
      selected.add("desktop-browser")
    } else if (
      /^(?:apps\/(?:cli|skill-installer|docs)\/|packages\/openclaw-plugin\/|plugins\/worktable\/|scripts\/lab\/)/.test(
        path
      ) ||
      repositoryDocsOnly([path])
    ) {
      // Required owns command, installer, plugin and lab behavior. Root build
      // and typecheck still run in Verify for every product change.
    } else return [...allSuites]
  }
  return allSuites.filter((id) => selected.has(id))
}

export function needsPluginPackaging(paths: string[]): boolean {
  if (paths.length === 0) return true
  return paths.some((path) => {
    if (
      /^(?:packages\/(?:openclaw-plugin|hosted-contract)\/|plugins\/worktable\/)/.test(
        path
      )
    )
      return true
    if (repositoryDocsOnly([path])) return false
    if (
      /^(?:apps\/|packages\/(?:server|mcp|mcp-connect|types|ui|public-analytics)\/|fixtures\/|docs\/)/.test(
        path
      )
    )
      return false
    // Workflow, lockfile, exporter, build and unfamiliar inputs are conservative.
    return true
  })
}

export function publicChangePaths(base: string, head: string): string[] {
  try {
    if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha))) return []
    return execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    )
      .split("\0")
      .filter(Boolean)
  } catch {
    return []
  }
}

if (import.meta.main) {
  const paths = publicChangePaths(
    process.env.BASE_SHA ?? "",
    process.env.HEAD_SHA ?? ""
  )
  const forcedFull = process.env.FULL_VERIFY === "true"
  const documentation = !forcedFull && repositoryDocsOnly(paths)
  const productDocumentation = !forcedFull && productDocsOnly(paths)
  const suites =
    documentation || productDocumentation
      ? []
      : forcedFull
        ? allSuites
        : selectPublicSuiteIds(paths)
  const outputs = {
    scope: documentation
      ? "documentation"
      : productDocumentation
        ? "product-docs"
        : suites.length === allSuites.length
          ? "full"
          : "selected",
    browser: !documentation && suites.some((id) => id.endsWith("-browser")),
    desktop: !documentation && suites.includes("desktop-contracts"),
    plugin: needsPluginPackaging(paths),
    required: !documentation && !productDocumentation,
    // Reuse this exact immutable diff for execution rather than discovering a
    // different base later from the merge checkout or local branch tracking.
    suites: suites.join(","),
  }
  const text =
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text)
  else process.stdout.write(text)
}
