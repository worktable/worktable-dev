import type { ReactNode } from "react"
import { DocumentStatus } from "@worktable/ui/components/document-status"
import { DocumentCheckFailed } from "@/hooks/use-document-check-status"

/** Keep the same renderer mounted while a background page check is unavailable. */
export function DocumentCheckStatus({
  unavailable,
  children,
}: {
  unavailable: boolean
  children: ReactNode
}) {
  return (
    <DocumentCheckFailed.Provider value={unavailable}>
      {children}
      {unavailable && <DocumentStatus state="offline" />}
    </DocumentCheckFailed.Provider>
  )
}
