import * as Menu from "@radix-ui/react-dropdown-menu"
import * as Popover from "@radix-ui/react-popover"
import type { ComponentProps } from "react"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"
import { Check } from "lucide-react"

// The mobile toolbar deliberately keeps Radix's focus contract: cancelling
// pointerdown preserves the editor selection and the on*AutoFocus hooks keep
// the software keyboard open. Do not couple those overrides to BlockNote's
// default desktop UI implementation (which now uses Base UI).
function MenuContent({
  className,
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Content
      className={cn(
        "z-50 min-w-32 rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
        className
      )}
      {...props}
    />
  )
}

function MenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return (
    <Menu.Item
      className={cn(
        "bn-menu-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent",
        className
      )}
      {...props}
    />
  )
}

function MenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem
      className={cn(
        "bn-menu-item flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent",
        className
      )}
      {...props}
    >
      <Menu.ItemIndicator>
        <Check className="size-3.5" />
      </Menu.ItemIndicator>
      {children}
    </Menu.CheckboxItem>
  )
}

function MenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label
      className={cn(
        "px-2 py-1.5 text-xs font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function PopoverContent({
  className,
  ...props
}: ComponentProps<typeof Popover.Content>) {
  return (
    <Popover.Content
      className={cn(
        "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none",
        className
      )}
      {...props}
    />
  )
}

export const mobileToolbarPrimitives = {
  Button: { Button },
  DropdownMenu: {
    DropdownMenu: Menu.Root,
    DropdownMenuTrigger: Menu.Trigger,
    DropdownMenuContent: MenuContent,
    DropdownMenuItem: MenuItem,
    DropdownMenuCheckboxItem: MenuCheckboxItem,
    DropdownMenuLabel: MenuLabel,
  },
  Popover: {
    Popover: Popover.Root,
    PopoverTrigger: Popover.Trigger,
    PopoverContent,
  },
}
