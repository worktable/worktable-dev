import { useFolderListParts } from "@/lib/list-beside"

/** A folder's own page, drawn once the sidebar's code is in. */
export function FolderRoute() {
  const parts = useFolderListParts()
  return parts ? <parts.FolderRoutePage /> : null
}
