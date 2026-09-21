"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@worktable/ui/lib/utils"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "well switch-track peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-input px-0.5 transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="block size-4 rounded-full bg-primary transition-transform data-checked:translate-x-3.5"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
