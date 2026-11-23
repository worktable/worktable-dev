import { useSyncExternalStore } from "react"
import { mediaQueryStore } from "@/hooks/use-mobile"

// The width at which a folder's list fits beside a page (Tailwind's lg).
const wide = mediaQueryStore("(min-width: 1024px)")

/** Whether Folders Only shows a folder's list beside the page. */
export function useFolderColumnFits(): boolean {
  return useSyncExternalStore(wide.subscribe, wide.getSnapshot, () => false)
}
