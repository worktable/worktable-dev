import { createContext, useContext, type ReactNode } from "react"
import { DocumentStatus } from "@worktable/ui/components/document-status"

const DocumentCheckFailed = createContext(false)

/** The document's own sync indicator yields to this shared connection notice. */
export function useDocumentCheckFailed(): boolean {
  return useContext(DocumentCheckFailed)
}

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
