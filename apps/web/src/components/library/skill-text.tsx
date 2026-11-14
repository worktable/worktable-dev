import { useState, type ReactNode } from "react"
import { cn } from "@worktable/ui/lib/utils"
import type { TextLine, TextPart } from "@/lib/library-view"

const LINE: Record<TextLine["kind"], string> = {
  same: "text-reading-foreground",
  added: "bg-success/10 text-foreground shadow-[inset_2px_0_0_var(--success)]",
  removed:
    "bg-destructive/10 text-muted-foreground line-through decoration-destructive/40 shadow-[inset_2px_0_0_var(--destructive)]",
}

const SAID: Partial<Record<TextLine["kind"], string>> = {
  added: "Added: ",
  removed: "Removed: ",
}

/** A line's code and strong words, which read as noise when left as marks. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((piece, index) =>
    /^`.+`$/.test(piece) ? (
      <code
        key={index}
        className="inline-code-accent rounded px-1 font-mono text-[0.9em]"
      >
        {piece.slice(1, -1)}
      </code>
    ) : /^\*\*.+\*\*$/.test(piece) ? (
      <strong key={index} className="font-semibold">
        {piece.slice(2, -2)}
      </strong>
    ) : (
      piece
    )
  )
}

function Lines({ lines }: { lines: TextLine[] }) {
  return (
    <>
      {lines.map((line, index) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(line.text)
        return (
          <div
            key={index}
            className={cn(
              "-mx-3 px-3",
              LINE[line.kind],
              heading && "font-semibold",
              // A blank line parts paragraphs without taking a line's room.
              !line.text.trim() && "h-3"
            )}
          >
            {SAID[line.kind] && (
              <span className="sr-only">{SAID[line.kind]}</span>
            )}
            {heading
              ? inline(heading[1]!)
              : line.text
                ? inline(line.text)
                : " "}
          </div>
        )
      })}
    </>
  )
}

function Fold({ lines }: { lines: TextLine[] }) {
  const [open, setOpen] = useState(false)
  if (open) return <Lines lines={lines} />
  return (
    <button
      type="button"
      className="block py-0.5 text-left font-sans text-xs tracking-normal text-muted-foreground transition-colors hover:text-foreground"
      onClick={() => setOpen(true)}
    >
      {lines.length} more {lines.length === 1 ? "line" : "lines"}
    </button>
  )
}

/**
 * A skill's text line by line as its Doc holds it, with what a change drops
 * and adds marked and unchanged stretches folded.
 */
export function SkillText({ parts }: { parts: TextPart[] }) {
  return (
    <div className="text-sm leading-6 break-words whitespace-pre-wrap">
      {parts.map((part, index) =>
        part.kind === "fold" ? (
          <Fold key={index} lines={part.lines} />
        ) : (
          <Lines key={index} lines={part.lines} />
        )
      )}
    </div>
  )
}
