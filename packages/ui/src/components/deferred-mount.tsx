import { Suspense, useState, type ReactNode } from "react"

/** Mount on first use, retaining state and exit animations after closing. */
export function DeferredMount({
  active,
  children,
}: {
  active: boolean
  children: ReactNode
}) {
  const [requested, setRequested] = useState(active)
  if (active && !requested) setRequested(true)
  return requested ? <Suspense fallback={null}>{children}</Suspense> : null
}
