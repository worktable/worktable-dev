import { useState } from "react"

export type BylineSection = "activity" | "links"

/**
 * What is open in a byline. A Doc page shows its byline twice while it
 * opens, in the preview and then in the editor; sharing this keeps a panel
 * or the archive date open across that swap.
 */
export interface BylineState {
  open: BylineSection | null
  setOpen: (panel: BylineSection | null) => void
  lifetimeOpen: boolean
  setLifetimeOpen: (open: boolean) => void
}

export function useBylineState(): BylineState {
  const [open, setOpen] = useState<BylineSection | null>(null)
  const [lifetimeOpen, setLifetimeOpen] = useState(false)
  return { open, setOpen, lifetimeOpen, setLifetimeOpen }
}
