import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runBackupWorkerJob } from "./workspace-backup-worker.ts"

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
shift 4
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
