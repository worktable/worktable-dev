import type { ActivityActor } from "@worktable/types"
import { formatArchiveDate } from "./lifetime"

export function actorName(actor: ActivityActor): string {
  if (actor.kind === "person") return "You"
  return actor.name ?? (actor.kind === "agent" ? "An agent" : "Worktable")
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function dayLabel(iso: string, now = new Date()): string {
  const days = Math.round(
    (startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000
  )
  if (days <= 0) return "Today"
  if (days === 1) return "Yesterday"
  const date = new Date(iso)
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" })
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
}

export function groupByDay<T extends { at: string }>(
  items: T[]
): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = []
  for (const item of items) {
    const label = dayLabel(item.at)
    const last = groups.at(-1)
    if (last?.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}

/** "9:42" today, "Yesterday", a weekday this week, then a date. */
export function shortWhen(iso: string, now = new Date()): string {
  const date = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days <= 0) return clockTime(iso)
  if (days === 1) return "Yesterday"
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" })
  return formatArchiveDate(iso)
}
