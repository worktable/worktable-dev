import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Input } from "@worktable/ui/components/input"
import { toast } from "@worktable/ui/components/sonner"
import {
  fetchUserProfile,
  getCurrentUser,
  profileStorageKey,
  setCurrentUser,
  updateUserProfile,
} from "@/lib/profile"
import { queryKeys } from "@/lib/queries"

export function ProfileSection() {
  return (
    <div className="flex flex-col gap-6">
      <DisplayNameGroup />
    </div>
  )
}

// ── Display name ─────────────────────────────────────────────────────────────

const DEFAULT_NAME = "User"

function DisplayNameGroup() {
  const queryClient = useQueryClient()
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
      // Only this person's profile in this Worktable, not another tab's.
      if (e.key !== profileStorageKey()) return
      if (!hasLocalEdit.current) {
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
      // The sidebar shows the name from the workspace summary.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspace,
        exact: true,
      })
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
