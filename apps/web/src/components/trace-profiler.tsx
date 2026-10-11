import { Profiler, type ReactNode } from "react"
import { traceEnabled, traceRender } from "@/lib/trace"

/** Times a shell region's render commits when tracing is on. */
export function TraceProfiler({
  id,
  children,
}: {
  id: string
  children: ReactNode
}) {
  if (!traceEnabled()) return children
  return (
    <Profiler id={id} onRender={traceRender}>
      {children}
    </Profiler>
  )
}
