import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { BOOT_FACTS_MARKER, readBootFacts } from "./boot-facts.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import { setWorkspaceStorageUpgradeState } from "./workspace-storage-upgrade.ts"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-boot-facts-"))
  setAppDirOverride(join(root, "app"))
})

afterEach(async () => {
  setWorkspaceStorageUpgradeState("ready")
  await rm(root, { recursive: true, force: true })
})

it("carries only the upgrade state while workspace storage is being upgraded", async () => {
  // The workspace cannot be read here, so reading it would lose the facts.
  await writeFile(join(root, "not-a-directory"), "")
  setWorkspaceRootOverride(join(root, "not-a-directory", "workspace"))
  setWorkspaceStorageUpgradeState("upgrading")
  const navigation = new Request("http://127.0.0.1:7480/spaces/notes", {
    headers: {
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    },
  })

  expect(await readBootFacts(navigation, BOOT_FACTS_MARKER, "build-1")).toEqual(
    {
      build: "build-1",
      storageUpgrade: { state: "upgrading", canRetry: true },
    }
  )
})
