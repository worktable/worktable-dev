import { useEffect, useRef, useState } from "react"
import { Input } from "@worktable/ui/components/input"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import { useTheme } from "@/components/theme-provider"
import {
  fetchUserProfile,
  getCurrentUser,
  setCurrentUser,
  updateUserProfile,
} from "@/lib/profile"

type ThemeValue = "system" | "light" | "dark"

// Hand-drawn token-built thumbnails — a page rect with a sidebar bar. No assets;
// the swatches read the same in either resolved theme (they're literal colors).
const THEME_OPTIONS: { value: ThemeValue; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

export function AppearanceSection() {
  return (
    <div className="flex flex-col gap-6">
      <ThemeGroup />
      <DisplayNameGroup />
    </div>
  )
}

// ── Theme ────────────────────────────────────────────────────────────────────

function ThemeThumbnail({ value }: { value: ThemeValue }) {
  if (value === "light") {
    return (
      <div className="flex h-full w-full overflow-hidden rounded bg-white">
        <div className="h-full w-1/3 bg-neutral-200" />
      </div>
    )
  }
  if (value === "dark") {
    return (
      <div className="flex h-full w-full overflow-hidden rounded bg-neutral-900">
        <div className="h-full w-1/3 bg-neutral-800" />
      </div>
    )
  }
  // System: half light, half dark — each half keeps its own sidebar bar.
  return (
    <div className="flex h-full w-full overflow-hidden rounded">
      <div className="flex h-full w-1/2 bg-white">
        <div className="h-full w-1/3 bg-neutral-200" />
      </div>
      <div className="flex h-full w-1/2 bg-neutral-900">
        <div className="h-full w-1/3 bg-neutral-800" />
      </div>
    </div>
  )
}

function ThemeGroup() {
  const { theme, setTheme } = useTheme()

  // Arrow-key navigation across the radios (optional polish); Enter/Space select
  // is handled natively via the button role fallback below.
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
    e.preventDefault()
    const index = THEME_OPTIONS.findIndex((o) => o.value === theme)
    const delta = e.key === "ArrowRight" ? 1 : -1
    const next =
      THEME_OPTIONS[
        (index + delta + THEME_OPTIONS.length) % THEME_OPTIONS.length
      ]
    setTheme(next.value)
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Theme</h3>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-3 gap-3"
          onKeyDown={handleKeyDown}
        >
          {THEME_OPTIONS.map((option) => {
            const selected = theme === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTheme(option.value)}
                className="flex flex-col items-center gap-2 outline-none"
              >
                <span
                  className={cn(
                    "block h-14 w-full rounded-lg border border-border p-1 transition-shadow",
                    selected && "ring-2 ring-primary"
                  )}
                >
                  <ThemeThumbnail value={option.value} />
                </span>
                <span
                  className={cn(
                    "text-sm",
                    selected ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {option.label}
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-sm text-muted-foreground">
          Shortcut: press <kbd className="inline-code-accent font-mono">d</kbd>{" "}
          to toggle.
        </p>
      </div>
    </section>
  )
}

// ── Display name ─────────────────────────────────────────────────────────────

const DEFAULT_NAME = "User"

function DisplayNameGroup() {
  const [value, setValue] = useState(() => getCurrentUser().name)
  const [saving, setSaving] = useState(false)
  const editRevision = useRef(0)
  const hasLocalEdit = useRef(false)

  useEffect(() => {
    let cancelled = false
    const requestedAtRevision = editRevision.current
    void fetchUserProfile()
      .then((profile) => {
        if (!cancelled && editRevision.current === requestedAtRevision) {
          setCurrentUser(profile)
          setValue(profile.name)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Keep the field in sync if another tab changed the profile while open.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === "worktable-profile" && !hasLocalEdit.current) {
        editRevision.current += 1
        setValue(getCurrentUser().name)
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  async function commit() {
    const trimmed = value.trim()
    const next = trimmed || DEFAULT_NAME
    const current = getCurrentUser()
    if (next === current.name) {
      hasLocalEdit.current = false
      return setValue(next)
    }
    setSaving(true)
    try {
      const profile = await updateUserProfile(next)
      hasLocalEdit.current = false
      setValue(profile.name)
    } catch (error) {
      hasLocalEdit.current = false
      setValue(current.name)
      toast.error(
        error instanceof Error ? error.message : "Couldn’t update your name."
      )
    } finally {
      setSaving(false)
    }
  }

  const initial = (value.trim() || DEFAULT_NAME).charAt(0).toUpperCase()

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Display name</h3>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-sm font-medium text-foreground"
          >
            {initial}
          </span>
          <Input
            aria-label="Display name"
            value={value}
            onChange={(e) => {
              editRevision.current += 1
              hasLocalEdit.current = true
              setValue(e.target.value)
            }}
            onBlur={() => void commit()}
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
            }}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Shown on your comments and Threads.
        </p>
      </div>
    </section>
  )
}
