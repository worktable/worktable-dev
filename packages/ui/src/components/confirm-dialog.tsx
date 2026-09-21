import type { ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import { Button } from "./button"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "./responsive-dialog"

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  variant?: "default" | "destructive"
  icon?: ReactNode
  children?: ReactNode
  loading?: boolean
  loadingLabel?: string
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  icon,
  children,
  loading = false,
  loadingLabel = "Working...",
  onConfirm,
}: ConfirmDialogProps) {
  const handleConfirm = async () => {
    await onConfirm()
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div
            className={`mb-1 flex h-10 w-10 items-center justify-center rounded-lg ${variant === "destructive" ? "bg-destructive/10" : "bg-surface-tint"}`}
          >
            {icon ?? (
              <AlertTriangle
                className={`h-5 w-5 ${variant === "destructive" ? "text-destructive" : "text-primary"}`}
              />
            )}
          </div>
          <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {description}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {children && <ResponsiveDialogBody>{children}</ResponsiveDialogBody>}

        <ResponsiveDialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={() => void handleConfirm()}
            disabled={loading}
          >
            {loading ? loadingLabel : confirmLabel}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
