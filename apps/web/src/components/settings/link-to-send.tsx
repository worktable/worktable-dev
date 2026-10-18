import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"

/** A link someone sends on themselves, selectable when copying fails. */
export function LinkToSend({
  text,
  label,
  url,
  copy,
  onCopy,
}: {
  text: string
  label: string
  url: string
  copy: string
  onCopy: () => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-inset p-3">
      <p className="text-sm text-muted-foreground">{text}</p>
      <div className="flex gap-2">
        <Input
          aria-label={label}
          value={url}
          readOnly
          className="min-w-0 flex-1"
          onFocus={(event) => event.target.select()}
        />
        <Button type="button" variant="outline" onClick={onCopy}>
          {copy}
        </Button>
      </div>
    </div>
  )
}
