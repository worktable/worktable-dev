import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible"
import { cn } from "../lib/utils"

export function Disclosure({
  title,
  children,
  className,
  keepMounted,
  defaultOpen,
}: {
  title: ReactNode
  children: ReactNode
  className?: string
  keepMounted?: boolean
  defaultOpen?: boolean
}) {
  return (
    <Collapsible className={cn("text-sm", className)} defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&[data-panel-open]>svg]:rotate-90">
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 transition-transform duration-250 motion-reduce:transition-none"
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted={keepMounted}>
        <div className="pt-2 pb-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
