import { Button } from "@worktable/ui/components/button"
import { useCopy } from "@worktable/ui/hooks/use-copy"

export function Prompt({ text }: { text: string }) {
  const copy = useCopy()
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-surface-inset py-2 pr-2 pl-3 text-sm leading-6 text-foreground">
      <span className="min-w-0 flex-1">{text}</span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2.5 text-xs"
        onClick={() => void copy.copy(text)}
      >
        {copy.copied ? "Copied" : "Copy"}
      </Button>
    </li>
  )
}
