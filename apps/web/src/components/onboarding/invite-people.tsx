import { useRef, useState } from "react"
import { X } from "lucide-react"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { EMAIL, type Invited } from "@/lib/invite-people"

/** Addresses as chips; a comma, a space or Enter adds what was typed. */
export function EmailChips({
  emails,
  onChange,
  onSubmit,
  autoFocus = false,
}: {
  emails: string[]
  onChange: (emails: string[]) => void
  onSubmit: () => void
  autoFocus?: boolean
}) {
  const [text, setText] = useState("")
  const input = useRef<HTMLInputElement>(null)
  function add(value: string): boolean {
    const found = value
      .split(/[\s,;]+/)
      .map((item) => item.trim().toLowerCase())
      .filter((item) => EMAIL.test(item) && !emails.includes(item))
    if (!found.length) return false
    onChange([...emails, ...new Set(found)])
    setText("")
    return true
  }
  return (
    <div
      className="flex min-h-10 cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
      onClick={() => input.current?.focus()}
    >
      {emails.map((email) => (
        <span
          key={email}
          className="flex items-center gap-1 rounded-md bg-surface-tint py-0.5 pr-1 pl-2 text-sm text-foreground"
        >
          {email}
          <button
            type="button"
            aria-label={`Remove ${email}`}
            className="grid size-4 place-items-center rounded text-muted-foreground hover:text-foreground"
            onClick={() => onChange(emails.filter((item) => item !== email))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={input}
        id="invite-emails"
        type="email"
        autoFocus={autoFocus}
        autoComplete="off"
        className="min-w-40 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
        placeholder={emails.length ? "" : "name@company.com"}
        value={text}
        onChange={(event) => {
          const value = event.target.value
          if (/[\s,;]$/.test(value) && add(value)) return
          setText(value)
        }}
        onPaste={(event) => {
          if (add(event.clipboardData.getData("text"))) event.preventDefault()
        }}
        onBlur={() => add(text)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            if (!add(text) && !text && emails.length) onSubmit()
          } else if (event.key === "Backspace" && !text && emails.length) {
            onChange(emails.slice(0, -1))
          }
        }}
      />
    </div>
  )
}

export function InviteResult({ invited, cloud }: { invited: Invited; cloud: boolean }) {
  const copy = useCopy()
  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-3 text-sm">
      <span className="min-w-0 flex-1 truncate text-foreground">{invited.email}</span>
      {invited.error ? (
        <span className="shrink-0 text-xs text-destructive">{invited.error}</span>
      ) : invited.status === "sent" ? (
        <span className="shrink-0 text-xs text-muted-foreground">Emailed</span>
      ) : invited.url ? (
        <>
          {cloud && (
            <span className="shrink-0 text-xs text-muted-foreground">
              Not emailed
            </span>
          )}
          <button
            type="button"
            className="shrink-0 text-xs font-medium text-primary-text hover:underline"
            onClick={() => void copy.copy(invited.url!)}
          >
            {copy.copied ? "Copied" : "Copy link"}
          </button>
        </>
      ) : null}
    </li>
  )
}
