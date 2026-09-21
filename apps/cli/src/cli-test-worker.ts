import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs"
import { basename, join } from "node:path"
import { runCliInProcess } from "./cli-test-runner.ts"

interface WorkerRequest {
  args: string[]
  env: Record<string, string>
}

const mailbox = process.argv[2]
if (!mailbox) throw new Error("CLI test worker requires a mailbox directory")

const readyPath = join(mailbox, "ready")
const stopPath = join(mailbox, "stop")
writeFileSync(readyPath, `${process.pid}\n`, { mode: 0o600 })

let pendingChange = false
let resolveChange: (() => void) | undefined
const watcher = watch(mailbox, () => {
  pendingChange = true
  resolveChange?.()
  resolveChange = undefined
})
const waitForMailboxChange = (): Promise<void> => {
  if (pendingChange) {
    pendingChange = false
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    // test-policy: external-readiness-backoff
    const fallback = setTimeout(() => {
      resolveChange = undefined
      resolve()
    }, 50)
    resolveChange = () => {
      clearTimeout(fallback)
      pendingChange = false
      resolve()
    }
  })
}

try {
  while (!existsSync(stopPath)) {
    const requests = readdirSync(mailbox)
      .filter((name) => name.startsWith("request-") && name.endsWith(".json"))
      .sort()
    if (requests.length === 0) {
      await waitForMailboxChange()
      continue
    }

    for (const name of requests) {
      const id = basename(name, ".json").slice("request-".length)
      const requestPath = join(mailbox, name)
      const responsePath = join(mailbox, `response-${id}.json`)
      const temporaryPath = `${responsePath}.${process.pid}.tmp`
      try {
        const request = (await Bun.file(requestPath).json()) as WorkerRequest
        const response = await runCliInProcess(request.args, request.env)
        writeFileSync(temporaryPath, JSON.stringify(response), { mode: 0o600 })
      } catch (error) {
        writeFileSync(
          temporaryPath,
          JSON.stringify({
            stdout: "",
            stderr: `CLI test worker failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
            exitCode: 1,
          }),
          { mode: 0o600 }
        )
      }
      renameSync(temporaryPath, responsePath)
      rmSync(requestPath, { force: true })
    }
  }
} finally {
  watcher.close()
}

process.exit(0)
