import { useState } from "react"
import {
  useFolderColumnFits,
  useFolderListParts,
  useRecentListed,
} from "@/lib/list-beside"

/**
 * Recent's list beside whatever page is open, from its See All. Always in
 * the layout on a wide screen, so opening it slides it in without moving
 * the page; its code comes with the sidebar's.
 */
export function RecentColumn() {
  const listed = useRecentListed()
  const fits = useFolderColumnFits()
  const lists = useFolderListParts(listed)
  // The list keeps showing while it slides closed.
  const [shown, setShown] = useState(listed)
  if (listed && !shown) setShown(true)
  if (!fits) return null
  return (
    <div
      className="shrink-0 overflow-clip transition-[width] duration-300 ease-in-out motion-reduce:transition-none print:hidden"
      style={{ width: listed ? "18rem" : 0 }}
      inert={!listed}
    >
      {shown && lists && <lists.RecentList />}
    </div>
  )
}
