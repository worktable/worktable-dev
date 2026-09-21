export const LAB_EVIDENCE_SCRIPT = String.raw`#!/usr/bin/env node
"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const home = process.env.HOME || os.homedir()
const workspace =
  process.env.WORKTABLE_LAB_WORKSPACE || path.join(home, "Worktable")
const evidenceRoot = path.join(home, ".worktable-lab", "evidence")
const baselinePath = path.join(evidenceRoot, "workspace-baseline.json")

function walk(directory, base = directory, output = {}) {
  if (!fs.existsSync(directory)) return output
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) walk(absolute, base, output)
    else if (entry.isFile()) {
      const bytes = fs.readFileSync(absolute)
      output[path.relative(base, absolute)] = {
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      }
    }
  }
  return output
}

function commandJson(command, args) {
  try {
    return JSON.parse(
      execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    )
  } catch {
    return null
  }
}

function commandLine(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")[0]
  } catch {
    return null
  }
}

function jsonFiles(directory) {
  if (!fs.existsSync(directory)) return []
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name))
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function evidenceLocation(value, fallback = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback
  }
  if (value.kind === "worktable") return { kind: "worktable" }
  if (
    value.kind === "space" &&
    typeof value.spaceId === "string" &&
    value.spaceId.length > 0
  ) {
    return { kind: "space", spaceId: value.spaceId }
  }
  return fallback
}

function threads() {
  const spaces = path.join(workspace, "spaces")
  const results = []
  const locations = [
    {
      location: { kind: "worktable" },
      directory: path.join(workspace, "threads"),
    },
  ]
  if (fs.existsSync(spaces)) {
    for (const spaceId of fs.readdirSync(spaces)) {
      locations.push({
        location: { kind: "space", spaceId },
        directory: path.join(spaces, spaceId, "threads"),
      })
    }
  }
  for (const source of locations) {
    for (const file of jsonFiles(source.directory)) {
      const thread = readJson(file)
      if (!thread || thread.type !== "worktable.thread") continue
      const location =
        thread.version === 1
          ? evidenceLocation(
              { kind: "space", spaceId: thread.spaceId },
              source.location
            )
          : evidenceLocation(thread.location, source.location)
      results.push({
        id: thread.id,
        version: thread.version,
        location,
        revision: thread.revision,
        titleCharacters:
          typeof thread.title === "string" ? thread.title.length : null,
        participants: Array.isArray(thread.participants)
          ? thread.participants.map((participant) => ({
              id: participant.id,
              kind: participant.kind,
              name: participant.name,
            }))
          : [],
        messages: Array.isArray(thread.messages)
          ? thread.messages.map((message) => ({
              id: message.id,
              sequence: message.sequence,
              authorId: message.authorId,
              recipientIds: message.recipientIds,
              inReplyTo: message.inReplyTo,
              expectsReply: message.expectsReply,
              createdAt: message.createdAt,
              bodyCharacters:
                typeof message.body === "string" ? message.body.length : null,
            }))
          : [],
      })
    }
  }
  return results.sort((a, b) =>
    (JSON.stringify(a.location) + a.id).localeCompare(
      JSON.stringify(b.location) + b.id
    )
  )
}

function deliveryEvidence(appDir) {
  if (!appDir) return []
  return jsonFiles(path.join(appDir, "thread-deliveries")).flatMap((file) => {
    const parsed = readJson(file)
    if (!parsed || !Array.isArray(parsed.deliveries)) return []
    return parsed.deliveries.map((delivery) => ({
      messageId: delivery.messageId,
      threadId: delivery.threadId,
      location: evidenceLocation(
        delivery.location,
        typeof delivery.spaceId === "string" && delivery.spaceId.length > 0
          ? { kind: "space", spaceId: delivery.spaceId }
          : null
      ),
      participantId: delivery.participantId,
      state: delivery.state,
      revision: delivery.revision,
      attempts: delivery.attempts,
      error: delivery.error
        ? {
            code: delivery.error.code,
            retryable: delivery.error.retryable,
          }
        : undefined,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
    }))
  })
}

function latestLog() {
  const explicit = process.env.WORKTABLE_LAB_OPENCLAW_LOG
  if (explicit && fs.existsSync(explicit)) return explicit
  const directory = path.join("/tmp", "openclaw-" + process.getuid())
  if (!fs.existsSync(directory)) return null
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^openclaw-.*\.log$/.test(name))
    .map((name) => path.join(directory, name))
    .sort(
      (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
    )
  return files[0] || null
}

function gatewayEvidence() {
  const file = latestLog()
  const text = file ? fs.readFileSync(file, "utf8") : ""
  const messages = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const entry = JSON.parse(line)
        if (typeof entry.message === "string") return entry.message
        if (typeof entry["1"] === "string") return entry["1"]
      } catch {}
      return line
    })
  const count = (pattern) =>
    messages.filter((message) => pattern.test(message)).length
  const searchable = messages.join("\n")
  return {
    logPresent: Boolean(file),
    worktableCompleted: count(/Completed Worktable message/),
    worktableFailed: count(/\[worktable\].* failed /),
    dispatchErrors: count(/message dispatch completed:.*outcome=error/),
    dispatchSuccesses: count(
      /message dispatch completed:.*outcome=(?:success|ok)/
    ),
    workspaceVanished: count(/WorkspaceVanishedError/),
    pluginLoaded: /worktable .*@worktable\/openclaw|\bworktable\b.*plugin/gi.test(
      searchable
    ),
  }
}

function workspaceChanges(before, after) {
  const added = []
  const modified = []
  const deleted = []
  for (const [file, value] of Object.entries(after)) {
    if (!before[file]) added.push(file)
    else if (before[file].sha256 !== value.sha256) modified.push(file)
  }
  for (const file of Object.keys(before)) {
    if (!after[file]) deleted.push(file)
  }
  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
  }
}

fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
const currentManifest = walk(workspace)
if (process.argv[2] === "baseline") {
  fs.writeFileSync(
    baselinePath,
    JSON.stringify(
      { capturedAt: new Date().toISOString(), files: currentManifest },
      null,
      2
    ),
    { mode: 0o600 }
  )
  console.log(
    "Captured sanitized workspace baseline (" +
      Object.keys(currentManifest).length +
      " files)."
  )
  process.exit(0)
}

const runtimePaths = commandJson("worktable", ["paths", "--json"])
const appDir =
  process.env.WORKTABLE_LAB_APP_DIR ||
  (runtimePaths && typeof runtimePaths.appDir === "string"
    ? runtimePaths.appDir
    : null)
const baseline = readJson(baselinePath)
const report = {
  type: "worktable.lab-evidence",
  version: 1,
  generatedAt: new Date().toISOString(),
  labName: process.env.WORKTABLE_LAB_NAME || null,
  runtime: {
    worktable: runtimePaths?.version || commandLine("worktable", ["--version"]),
    openclaw: commandLine("openclaw", ["--version"]),
  },
  workspace: {
    path: workspace,
    baselineCapturedAt: baseline?.capturedAt || null,
    fileCount: Object.keys(currentManifest).length,
    changes: workspaceChanges(baseline?.files || currentManifest, currentManifest),
  },
  threads: threads(),
  deliveries: deliveryEvidence(appDir),
  gateway: gatewayEvidence(),
}
const stamp = report.generatedAt.replace(/[:.]/g, "-")
const output = path.join(evidenceRoot, "report-" + stamp + ".json")
fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 })

console.log("")
console.log("Sanitized lab evidence")
console.log(
  "• Workspace changes: +" +
    report.workspace.changes.added.length +
    " ~" +
    report.workspace.changes.modified.length +
    " -" +
    report.workspace.changes.deleted.length
)
console.log("• Threads: " + report.threads.length)
console.log("• Deliveries: " + report.deliveries.length)
console.log(
  "• Gateway completions/failures: " +
    report.gateway.worktableCompleted +
    "/" +
    report.gateway.worktableFailed
)
if (!report.workspace.baselineCapturedAt)
  console.log("• Baseline: missing; file-change comparison is unavailable")
console.log("• Report: " + output)
`
