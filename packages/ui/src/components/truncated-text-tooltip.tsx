"use client"

import type { ReactNode, Ref } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"

/** Loaded on intent so sidebar labels do not load tooltip code at startup. */
export default function TruncatedTextTooltip({
  open,
  text,
  children,
  triggerRef,
  onClose,
}: {
  open: boolean
  text: string
  children: ReactNode
  triggerRef: Ref<HTMLSpanElement>
  onClose: () => void
}) {
  return (
    <Tooltip
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <TooltipTrigger
        render={<span ref={triggerRef} className="block truncate" />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        role="tooltip"
        className="block font-normal tracking-normal break-words whitespace-normal normal-case"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
