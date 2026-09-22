import { rmSync } from "node:fs"
import { join } from "node:path"
import { getAppDir } from "./app-storage.ts"
import { workspaceCacheKey } from "./workspace.ts"

/** Call only with the server stopped, before opening the replacement's caches. */
export function retireWorkspaceDerivedFiles(): void {
  const root = getAppDir()
  const key = workspaceCacheKey()
  for (const path of [
    join(root, "yjs", key),
    join(root, "records-index", key),
  ]) {
    rmSync(path, { recursive: true, force: true })
  }
}
