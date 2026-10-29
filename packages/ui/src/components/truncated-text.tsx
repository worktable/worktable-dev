"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import { cn } from "@worktable/ui/lib/utils"

/** A single-line label that reveals its full text only when it is clipped. */
export function TruncatedText({
  text,
  children = text,
  className,
}: {
  text: string
  children?: ReactNode
  className?: string
}) {
  const label = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)

  // Only an open tooltip needs to watch resizing. The next hover measures
  // afresh, including after a rename, font load, or sidebar resize.
  useEffect(() => {
    const element = label.current
    if (!open || !element) return
    const observer = new ResizeObserver(() => {
      if (element.scrollWidth <= element.clientWidth) setOpen(false)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [open, text])

  return (
    <Tooltip
      open={open}
      onOpenChange={(nextOpen) => {
        const element = label.current
        setOpen(
          nextOpen && !!element && element.scrollWidth > element.clientWidth
        )
      }}
    >
      <TooltipTrigger
        delay={500}
        render={<span ref={label} />}
        className={cn("min-w-0 truncate", className)}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent className="block font-normal tracking-normal break-words whitespace-normal normal-case">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
