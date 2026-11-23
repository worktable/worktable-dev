import { useEffect, useSyncExternalStore } from "react"
import type { FolderList, FolderRoutePage } from "@/components/spaces/folder-list"

/**
 * The folder list ships inside the sidebar's code, which every page loads
 * once its first screen settles, so it adds no file of its own. Pages take
 * it from there when it has arrived, without suspending, so the list opens
 * the moment it's asked for.
 */
interface FolderListParts {
  FolderList: typeof FolderList
  FolderRoutePage: typeof FolderRoutePage
}

let parts: FolderListParts | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function load(): Promise<void> {
  loading ??= import("@/components/app-sidebar").then((module) => {
    parts = { FolderList: module.FolderList, FolderRoutePage: module.FolderRoutePage }
    for (const listener of listeners) listener()
  })
  return loading
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The folder list's components, once the sidebar's code is in. */
export function useFolderListParts(): FolderListParts | null {
  useEffect(() => {
    void load()
  }, [])
  return useSyncExternalStore(subscribe, () => parts, () => null)
}
