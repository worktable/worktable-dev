import { useSyncExternalStore } from "react"

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

const subscribe = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false

/** Keep hydration stable, then show relative time immediately on later mounts. */
export function RelativeTime({ iso }: { iso: string }) {
  const client = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot)
  return (
    <span title={formatDate(iso)}>
      {client ? timeAgo(iso) : formatDate(iso)}
    </span>
  )
}
