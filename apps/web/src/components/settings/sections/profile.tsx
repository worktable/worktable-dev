import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { recognitionColor } from "@worktable/types/recognition"
import { Input } from "@worktable/ui/components/input"
import { toast } from "@worktable/ui/components/sonner"
import {
  fetchUserProfile,
  getCurrentUser,
  setCurrentUser,
  updateUserProfile,
} from "@/lib/profile"
import { queryKeys, useWorkspace } from "@/lib/queries"
import { profileStorageKey } from "@/lib/team-context"
import { PersonAvatar } from "@/components/person-avatar"
import { EditMarkButton } from "@/components/edit-mark-button"
import type { WorkspaceInfo } from "@/lib/api"
import {
  personPhotoUrl,
  removePersonPhoto,
  uploadPersonPhoto,
} from "@/lib/identity-images"

const IdentityImageDialog = lazy(() =>
  import("@/components/identity-image-dialog").then((module) => ({
    default: module.IdentityImageDialog,
  }))
)

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
  const { data: workspace } = useWorkspace()
  const [value, setValue] = useState(() => getCurrentUser().name)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const personId = workspace?.person?.id ?? getCurrentUser().id
  const photo = workspace?.person?.photo ?? null
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

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Display name</h3>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <EditMarkButton label="Change Photo" round onClick={() => setPicking(true)}>
            <PersonAvatar
              id={personId}
              name={value.trim() || DEFAULT_NAME}
              photo={photo}
              size="lg"
            />
          </EditMarkButton>
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
      {picking ? (
        <Suspense fallback={null}>
          <IdentityImageDialog
            open
            onClose={() => setPicking(false)}
            kind="photo"
            currentImage={photo ? personPhotoUrl(personId, photo) : null}
            color={recognitionColor(null, personId)}
            name={value.trim() || DEFAULT_NAME}
            onSaveImage={async (image) => {
              const saved = await uploadPersonPhoto(image)
              applyOwnPhoto(queryClient, saved.id, saved.photo)
            }}
            {...(photo
              ? {
                  onRemove: async () => {
                    const saved = await removePersonPhoto()
                    applyOwnPhoto(queryClient, saved.id, null)
                  },
                }
              : {})}
          />
        </Suspense>
      ) : null}
    </section>
  )
}

/** Show your new photo everywhere this tab draws you, without a refetch. */
function applyOwnPhoto(
  queryClient: QueryClient,
  id: string,
  photo: string | null
) {
  const withPhoto = <T extends { photo?: string }>(entry: T): T => ({
    ...entry,
    photo: photo ?? undefined,
  })
  queryClient.setQueryData<WorkspaceInfo>(queryKeys.workspace, (workspace) => {
    if (!workspace) return workspace
    const presentations = workspace.presentations
      ? Object.fromEntries(
          Object.entries(workspace.presentations).map(([key, entry]) => [
            key,
            entry.id === id || key === id ? withPhoto(entry) : entry,
          ])
        )
      : undefined
    return {
      ...workspace,
      ...(presentations ? { presentations } : {}),
      person: workspace.person ? withPhoto(workspace.person) : workspace.person,
    }
  })
}
