import { useFolderListParts } from "@/lib/list-beside"

/** Recent's own page, drawn once the sidebar's code is in. */
export function RecentRoute() {
  const parts = useFolderListParts()
  return parts ? <parts.RecentPage /> : null
}
