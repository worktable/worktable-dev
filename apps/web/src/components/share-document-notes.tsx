import { AlertCircle, Globe2, Loader2 } from "lucide-react"
import { cn } from "@worktable/ui/lib/utils"

export function ShareAccessCard({
  state,
}: {
  state: "loading" | "error" | "inactive" | "active"
}) {
  const label = {
    loading: "Checking…",
    error: "Unavailable",
    inactive: "Not shared",
    active: "Active",
  }[state]

  return (
    <div className="rounded-xl bg-surface-tint p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-card text-primary">
          <Globe2 className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            Anyone with the link
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            View only · No sign-in required
          </p>
        </div>
        <span
          className={cn(
            "inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium",
            state === "active" && "bg-success/10 text-success",
            state === "error" && "bg-destructive/10 text-destructive",
            (state === "inactive" || state === "loading") &&
              "bg-muted text-muted-foreground"
          )}
          role={state === "loading" ? "status" : undefined}
        >
          {state === "loading" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <span
              className={cn(
                "size-1.5 rounded-full bg-current",
                state === "inactive" && "opacity-50"
              )}
            />
          )}
          {label}
        </span>
      </div>
    </div>
  )
}

export function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
      role="alert"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  )
}

export function HtmlSafetyNote() {
  return (
    <p className="px-1 text-xs leading-5 text-muted-foreground">
      Records and links to other Worktable content aren’t available in shared
      HTML docs.
    </p>
  )
}
