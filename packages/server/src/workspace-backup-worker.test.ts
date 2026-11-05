import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  incrementalUploadArguments,
  runBackupWorkerJob,
  type BackupParent,
  type UploadedFile,
} from "./workspace-backup-worker.ts"

const JOB = `bkp_${"a".repeat(32)}`
const SECRETS = {
  repository: "s3:https://r2.example.invalid/bucket/tenant-prefix",
  repositoryPassword: "repository-password-value",
  accessKeyId: "access-key-id-value",
  secretAccessKey: "secret-access-key-value",
  sessionToken: "session-token-value",
}
const RESTIC_STDERR = "restic-stderr-marker"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-backup-worker-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function executable(name: string, body: string) {
  const path = join(root, "bin", name)
  await mkdir(join(root, "bin"), { recursive: true })
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o700)
  return path
}

/** Restic always echoes its credentials to stderr, as a backend error can. */
async function fakeRestic(backupExit: number) {
  return executable(
    "restic",
    `echo "${RESTIC_STDERR} $RESTIC_REPOSITORY $RESTIC_PASSWORD $AWS_ACCESS_KEY_ID $AWS_SECRET_ACCESS_KEY $AWS_SESSION_TOKEN" >&2
while [ "\${1#-}" != "$1" ]; do
  case "$1" in --cache-dir|--stuck-request-timeout) shift 2 ;; *) shift ;; esac
done
case "$1" in
  cat) printf '{"id":"${"b".repeat(64)}"}\\n' ;;
  backup) printf '%s\\n' "$@" > ../restic-args.txt; exit ${backupExit} ;;
  *) exit 1 ;;
esac`
  )
}

/** The capture succeeds in the job directory; inspect runs `inspectBody`. */
async function fakeServer(inspectBody: string) {
  return executable(
    "worktable-server",
    `case "$1" in
  workspace-snapshot) mkdir -p capture/workspace && printf '{}' > capture/snapshot.json && echo '{}' ;;
  workspace-snapshot-inspect) ${inspectBody} ;;
  *) exit 2 ;;
esac`
  )
}

async function runJob(tools: { restic: string; server: string }) {
  const appDirectory = join(root, "app")
  const directory = join(appDirectory, "operator-snapshots", JOB)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "input.json"),
    JSON.stringify({
      version: 1,
      jobId: JOB,
      kind: "backup",
      workspaceId: "ws_backup_test",
      repository: SECRETS.repository,
      repositoryPassword: SECRETS.repositoryPassword,
      credentials: {
        accessKeyId: SECRETS.accessKeyId,
        secretAccessKey: SECRETS.secretAccessKey,
        sessionToken: SECRETS.sessionToken,
      },
      expiresAt: Date.now() + 60_000,
    })
  )
  const succeeded = await runBackupWorkerJob(JOB, {
    appDirectory,
    restic: tools.restic,
    server: [tools.server],
  })
  const failure = await readFile(join(directory, "failure.json"), "utf8")
  const progress = await readFile(join(directory, "progress.json"), "utf8")
  for (const text of [failure, progress]) {
    expect(text).not.toContain(RESTIC_STDERR)
    for (const secret of Object.values(SECRETS))
      expect(text).not.toContain(secret)
    expect(text).not.toContain("r2.example.invalid")
  }
  expect(existsSync(join(directory, "input.json"))).toBe(false)
  const uploadArguments = existsSync(join(directory, "restic-args.txt"))
    ? (await readFile(join(directory, "restic-args.txt"), "utf8"))
        .trimEnd()
        .split("\n")
    : undefined
  return {
    succeeded,
    failure: JSON.parse(failure),
    progress: JSON.parse(progress),
    uploadPaths: uploadArguments?.slice(uploadArguments.indexOf("--") + 1),
  }
}

describe("backup worker failures", () => {
  it("records the failed step and the server's reason without secrets", async () => {
    const workspace = process.env["WORKTABLE_WORKSPACE"]
    const job = await runJob({
      restic: await fakeRestic(0),
      server: await fakeServer(
        `echo "[Worktable server] workspace changed during export: ${workspace}/legacy-agentdash; retry" >&2; echo "    at inspect (/app/src/x.ts:1:1)" >&2; exit 1`
      ),
    })
    expect(job.succeeded).toBe(false)
    expect(job.failure).toMatchObject({
      jobId: JOB,
      state: "failed",
      detail: {
        step: "inspect",
        exitCode: 1,
        errorName: "BackupCommandError",
        message: "workspace changed during export: legacy-agentdash; retry",
      },
    })
    expect(job.progress).toMatchObject({ phase: "capturing", step: "inspect" })
  })

  it("records a failed upload by step and exit code only", async () => {
    const manifest = JSON.stringify({
      type: "worktable.workspace-snapshot",
      workspaceId: "ws_backup_test",
      files: [],
      visitorComments: {
        size: 3,
        checkpoint: { incarnation: "a".repeat(32), revision: 1 },
      },
    })
    const job = await runJob({
      restic: await fakeRestic(3),
      server: await fakeServer(`echo '${manifest}'`),
    })
    expect(job.failure.detail).toEqual({
      step: "upload",
      exitCode: 3,
      errorName: "BackupCommandError",
      message: "backup upload failed (exit 3)",
    })
    expect(job.progress).toMatchObject({ phase: "uploading", step: "upload" })
    expect(job.uploadPaths).toEqual([
      "workspace",
      "snapshot.json",
      "app/visitor-comments.sqlite",
    ])
  })

  it("reads the manifest from among other lines the server printed", async () => {
    const manifest = JSON.stringify({
      type: "worktable.workspace-snapshot",
      workspaceId: "ws_backup_test",
      files: [],
    })
    const job = await runJob({
      restic: await fakeRestic(3),
      server: await fakeServer(
        `echo 'a dependency notice'; echo '${manifest}'; echo '{"level":"info"}'`
      ),
    })
    // The manifest parsed: the job reached the upload.
    expect(job.failure.detail.step).toBe("upload")
    expect(job.uploadPaths).toEqual(["workspace", "snapshot.json"])
  })

  it("says how much of a cut-off result arrived, without quoting it", async () => {
    const job = await runJob({
      restic: await fakeRestic(0),
      server: await fakeServer(`printf '{"workspaceId":"ws_backup_test","fi'`),
    })
    expect(job.failure.detail).toMatchObject({
      step: "parse-manifest",
      message:
        "server command printed no snapshot manifest (35 bytes, cut off mid-line)",
    })
  })
})

describe("incremental uploads", () => {
  const at = "2026-01-01T00:00:00.000Z"
  const later = "2026-01-01T01:00:00.000Z"
  const parent: BackupParent = {
    version: 1,
    repositoryId: "b".repeat(64),
    workspaceId: "ws_backup_test",
    snapshotId: "c".repeat(64),
    files: [
      ["workspace/kept.md", 4, at, "1".repeat(64)],
      ["workspace/edited.md", 4, at, "2".repeat(64)],
    ],
  }
  const skipUnchanged = ["--parent", "c".repeat(64), "--ignore-inode"]

  it("reads every file without a parent", () => {
    expect(incrementalUploadArguments(undefined, parent.files)).toEqual([])
  })

  it("skips files unchanged since the parent, and rereads ones whose mtime moved", () => {
    const files: UploadedFile[] = [
      ["workspace/kept.md", 4, at, "1".repeat(64)],
      ["workspace/edited.md", 4, later, "3".repeat(64)],
      ["workspace/new.md", 4, at, "4".repeat(64)],
    ]
    expect(incrementalUploadArguments(parent, files)).toEqual(skipUnchanged)
  })

  it("reads every file when new bytes kept the parent's size and mtime", () => {
    // Restic would take the parent's content for it.
    const files: UploadedFile[] = [
      ["workspace/kept.md", 4, at, "1".repeat(64)],
      ["workspace/edited.md", 4, at, "3".repeat(64)],
    ]
    expect(incrementalUploadArguments(parent, files)).toEqual([])
  })
})

const WORKSPACE = "ws_backup_test"
const digest = (text: string) => createHash("sha256").update(text).digest("hex")

/** Writes a maintenance job and runs it, as the control plane would. */
async function runMaintain(restic: string, fields: Record<string, unknown>) {
  const appDirectory = join(root, "app")
  const directory = join(appDirectory, "operator-snapshots", JOB)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "input.json"),
    JSON.stringify({
      version: 1,
      jobId: JOB,
      kind: "maintain",
      workspaceId: WORKSPACE,
      repository: join(root, "repository"),
      repositoryPassword: SECRETS.repositoryPassword,
      repositoryId: "b".repeat(64),
      expiresAt: Date.now() + 10 * 60_000,
      forget: [],
      keep: [],
      orphanBefore: Date.now() - 86_400_000,
      ...fields,
    })
  )
  const succeeded = await runBackupWorkerJob(JOB, {
    appDirectory,
    restic,
    server: ["false"],
  })
  const read = async (name: string) =>
    existsSync(join(directory, name))
      ? JSON.parse(await readFile(join(directory, name), "utf8"))
      : undefined
  return {
    succeeded,
    result: await read("result.json"),
    failure: await read("failure.json"),
  }
}

describe("maintenance input", () => {
  const a = "1".repeat(64)
  const b = "2".repeat(64)
  const verify = { snapshotId: a, sourceCheckpoint: "3".repeat(64) }

  it.each([
    [
      "forgets a kept snapshot",
      { forget: [a, b], keep: [b] },
      "maintenance would forget a kept snapshot",
    ],
    [
      "forgets the verified snapshot",
      { forget: [a], keep: [b], verify },
      "maintenance would forget the verified snapshot",
    ],
  ])(
    "refuses a job that %s, before touching the repository",
    async (_, fields, message) => {
      const restic = await executable("restic", `touch "${root}/restic-ran"`)
      const job = await runMaintain(restic, fields)
      expect(job.succeeded).toBe(false)
      expect(job.failure.detail).toEqual({
        step: "input",
        errorName: "Error",
        message,
      })
      expect(existsSync(join(root, "restic-ran"))).toBe(false)
    }
  )
})

/** CI installs a pinned restic; elsewhere one on PATH is used if present. */
const RESTIC = process.env["WORKTABLE_TEST_RESTIC"] || Bun.which("restic")

describe.skipIf(!RESTIC)("maintenance against a real repository", () => {
  const run = (args: string[], cwd = root) => {
    const result = spawnSync(RESTIC!, ["--no-cache", ...args], {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"],
        HOME: root,
        RESTIC_REPOSITORY: join(root, "repository"),
        RESTIC_PASSWORD: SECRETS.repositoryPassword,
      },
    })
    if (result.status !== 0)
      throw new Error(`restic ${args[0]} failed: ${result.stderr}`)
    return result.stdout
  }
  /** A backup laid out as the worker uploads one. Returns its full id. */
  const backup = async (files: Record<string, string>, time?: string) => {
    const source = join(root, "sources", randomUUID())
    await mkdir(join(source, "workspace"), { recursive: true })
    for (const [path, text] of Object.entries(files))
      await writeFile(join(source, path), text)
    return JSON.parse(
      run(
        [
          "backup",
          "--json",
          "--quiet",
          "--host",
          WORKSPACE,
          ...(time ? ["--time", time] : []),
          "--",
          "workspace",
          "snapshot.json",
        ],
        source
      )
        .trim()
        .split("\n")
        .at(-1)!
    ).snapshot_id as string
  }
  const blobs = () => run(["list", "blobs"])

  it("forgets expired and orphaned snapshots, prunes their bytes and keeps the rest", async () => {
    run(["init", "--repository-version", "2"])
    const repositoryId = JSON.parse(run(["cat", "config"])).id as string
    const old = "2026-01-01 00:00:00"
    const shared = `shared ${randomUUID()}`
    const expiredOnly = `expired ${randomUUID()}`
    const orphanOnly = `orphan ${randomUUID()}`
    const sourceCheckpoint = "c".repeat(64)
    const expired = await backup(
      {
        "snapshot.json": "{}",
        "workspace/shared.md": shared,
        "workspace/expired.md": expiredOnly,
      },
      old
    )
    const kept = await backup(
      {
        "snapshot.json": JSON.stringify({
          type: "worktable.workspace-snapshot",
          workspaceId: WORKSPACE,
          sourceCheckpoint,
        }),
        "workspace/shared.md": shared,
      },
      old
    )
    const orphan = await backup(
      { "snapshot.json": "{}", "workspace/orphan.md": orphanOnly },
      old
    )
    const partial = await backup({ "snapshot.json": "{}" })
    const gone = "f".repeat(64)
    const stored = blobs()
    expect(stored).toContain(digest(expiredOnly))
    expect(stored).toContain(digest(orphanOnly))

    const job = await runMaintain(RESTIC!, {
      repositoryId,
      forget: [expired, gone],
      keep: [kept],
      readDataSubset: "50%",
      verify: { snapshotId: kept, sourceCheckpoint },
    })

    expect(job.failure).toBeUndefined()
    expect(job.result).toMatchObject({
      kind: "maintain",
      state: "complete",
      repositoryId,
      forgotten: [expired],
      missing: [gone],
      orphans: [orphan],
      remaining: 2,
      checked: "subset",
      verified: kept,
    })
    const left = JSON.parse(run(["snapshots", "--json"])).map(
      (row: { id: string }) => row.id
    )
    expect([...left].sort()).toEqual([kept, partial].sort())
    // Only the forgotten snapshots held these bytes, and the prune removed them.
    const pruned = blobs()
    expect(pruned).not.toContain(digest(expiredOnly))
    expect(pruned).not.toContain(digest(orphanOnly))
    run(["restore", kept, "--target", join(root, "restored")])
    expect(
      await readFile(join(root, "restored", "workspace", "shared.md"), "utf8")
    ).toBe(shared)
  }, 60_000)
})
