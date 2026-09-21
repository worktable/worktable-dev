import {
  CircleCheck,
  CircleX,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react"
import {
  Toaster as SonnerToaster,
  toast,
  type ToastClassnames,
  type ToasterProps,
} from "sonner"

import { buttonVariants } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"

const defaultClassNames: ToastClassnames = {
  toast:
    "worktable-toast overlay-floating relative flex w-(--width) items-start gap-2.5 rounded-lg bg-popover px-3 py-2.5 font-sans text-sm text-popover-foreground",
  content: "flex min-w-0 flex-1 flex-col gap-0.5",
  title: "font-medium leading-snug",
  description: "text-xs leading-relaxed text-muted-foreground",
  icon: "relative mt-0.5 flex size-4 shrink-0 items-center justify-center [&_svg]:size-4",
  actionButton: cn(
    buttonVariants({ variant: "outline", size: "xs" }),
    "ms-auto self-center"
  ),
  cancelButton: cn(
    buttonVariants({ variant: "ghost", size: "xs" }),
    "self-center"
  ),
  closeButton: cn(
    buttonVariants({ variant: "outline", size: "icon-xs" }),
    "absolute -start-3 -top-3 z-10 bg-popover"
  ),
  success: "[&_[data-icon]]:text-success",
  error: "[&_[data-icon]]:text-destructive",
  info: "[&_[data-icon]]:text-info",
  warning: "[&_[data-icon]]:text-warning",
  loading: "[&_[data-icon]]:text-primary",
}

const defaultIcons = {
  success: <CircleCheck className="text-success" aria-hidden="true" />,
  error: <CircleX className="text-destructive" aria-hidden="true" />,
  info: <Info className="text-info" aria-hidden="true" />,
  warning: <TriangleAlert className="text-warning" aria-hidden="true" />,
  loading: (
    <LoaderCircle className="animate-spin text-primary" aria-hidden="true" />
  ),
  close: <X aria-hidden="true" />,
}

function mergeClassNames(
  overrides: ToastClassnames | undefined
): ToastClassnames {
  const keys = new Set<keyof ToastClassnames>([
    ...(Object.keys(defaultClassNames) as (keyof ToastClassnames)[]),
    ...(Object.keys(overrides ?? {}) as (keyof ToastClassnames)[]),
  ])

  return Object.fromEntries(
    [...keys].map((key) => [key, cn(defaultClassNames[key], overrides?.[key])])
  )
}

/**
 * Canonical Worktable toast viewport. Sonner owns behavior and accessibility;
 * this adapter owns every visual decision through the shared design system.
 */
function Toaster({
  theme = "system",
  position = "bottom-right",
  icons,
  toastOptions,
  ...props
}: ToasterProps) {
  return (
    <SonnerToaster
      theme={theme}
      position={position}
      icons={{ ...defaultIcons, ...icons }}
      toastOptions={{
        ...toastOptions,
        unstyled: true,
        classNames: mergeClassNames(toastOptions?.classNames),
      }}
      {...props}
    />
  )
}

export { Toaster, toast }
export type { ToasterProps }
