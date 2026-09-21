import * as React from "react"
import { Loader2Icon } from "lucide-react"

import { cn } from "@worktable/ui/lib/utils"

function Spinner({
  className,
  decorative = false,
  ...props
}: React.ComponentProps<typeof Loader2Icon> & { decorative?: boolean }) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role={decorative ? undefined : "status"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : "Loading"}
      className={cn("size-4 motion-safe:animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
