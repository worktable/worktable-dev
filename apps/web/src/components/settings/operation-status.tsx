import type { ReactNode } from "react"
import { Check, Loader2, TriangleAlert } from "lucide-react"

/** The update flow's status treatment, shared by all settings operations. */
export function StatusRow({
  icon,
  children,
  alert = false,
}: {
  icon: ReactNode
  children: ReactNode
  alert?: boolean
}) {
  return (
    <div
      className="flex items-start gap-2.5 text-sm text-foreground"
      role={alert ? "alert" : "status"}
    >
      <span className="mt-0.5 shrink-0" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function OperationStatus({
  state,
  children,
  detail,
}: {
  state: "working" | "success" | "error" | "attention"
  children: ReactNode
  detail?: ReactNode
}) {
  const icon =
    state === "working" ? (
      <Loader2 className="size-4 animate-spin text-primary-text" />
    ) : state === "success" ? (
      <Check className="size-4 text-primary-text" />
    ) : (
      <TriangleAlert
        className={
          state === "error" ? "size-4 text-destructive" : "size-4 text-warning"
        }
      />
    )
  return (
    <StatusRow icon={icon} alert={state === "error"}>
      {children}
      {detail ? (
        <span className="mt-1 block text-xs text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </StatusRow>
  )
}
