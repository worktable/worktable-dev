import { Button } from "@worktable/ui/components/button"
import { useUseHere, worktableLabel, type AppChoice } from "@/lib/app-choices"

/**
 * Which Worktable an app reached through Cloud works in. Use Here moves it
 * here; Change opens Cloud's page for that app, which lists every choice.
 */
export function WorksInSetting({ app }: { app: AppChoice }) {
  const useHere = useUseHere()
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
        <Button
          size="sm"
          disabled={useHere.isPending}
          onClick={() => useHere.mutate(app)}
        >
          Use Here
        </Button>
      )}
    </div>
  )
}
