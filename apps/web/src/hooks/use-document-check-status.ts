import { createContext, useContext } from "react"

export const DocumentCheckFailed = createContext(false)

/** The document's own sync indicator yields to the shared connection notice. */
export function useDocumentCheckFailed(): boolean {
  return useContext(DocumentCheckFailed)
}
