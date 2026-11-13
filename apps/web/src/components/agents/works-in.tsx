import { useState } from "react"
import { Button } from "@worktable/ui/components/button"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { useMoveHere, worktableLabel, type AppChoice } from "@/lib/app-choices"

/**
 * Move Here, after asking: the app leaves the Worktable it works in now, and
 * any auto-reply there stops with it.
 */
export function MoveHereButton({ app }: { app: AppChoice }) {
  const [confirming, setConfirming] = useState(false)
  const moveHere = useMoveHere()
  if (!app.worktable || app.worktable.here) return null
  return (
    <>
      <Button size="sm" onClick={() => setConfirming(true)}>
        Move Here
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!moveHere.isPending) setConfirming(open)
        }}
        title={`Move ${app.name} here?`}
        description={`It stops working in ${worktableLabel(app.worktable)}, including any auto-reply there.`}
        confirmLabel="Move Here"
        loading={moveHere.isPending}
        loadingLabel="Moving…"
        onConfirm={() =>
          moveHere.mutate(app, { onSuccess: () => setConfirming(false) })
        }
      />
    </>
  )
}

/**
 * Which Worktable an app reached through Cloud works in. Move Here moves it
 * here; Change opens Cloud's page for that app, which lists every choice.
 */
export function WorksInSetting({ app }: { app: AppChoice }) {
  if (!app.worktable) return null
  const here = app.worktable.here
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Works in</div>
        <p className="truncate text-xs text-muted-foreground">
          {here ? "This Worktable" : worktableLabel(app.worktable)}
        </p>
      </div>
      {here ? (
        <a
          href={app.changeUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Change
        </a>
      ) : (
        <MoveHereButton app={app} />
      )}
    </div>
  )
}
