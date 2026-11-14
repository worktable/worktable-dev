import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Library as LibraryIcon } from "lucide-react"
import { useState } from "react"
import {
  savedSinceLive,
  type DocumentPage,
  type DocumentProvenance,
} from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { DOCUMENT_BYLINE_CHIP } from "@/components/document-organize"
import { documentQueryKeys } from "@/lib/documents-queries"

/**
 * On a Doc that is a skill: a chip to it in the Library, and Save while the Doc
 * holds changes agents don't have yet. The Doc's page names its skills and
 * its last save, kept current while it is open, says so without asking the
 * server again.
 */
export function DocumentSkillChip({
  spaceId,
  docPath,
  skills,
  provenance,
}: {
  spaceId: string
  docPath: string
  skills: NonNullable<DocumentPage["skills"]>
  provenance?: DocumentProvenance
}) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  // A waiting proposal is reviewed in the Library instead.
  const changed = skills.filter(
    (skill) => !skill.proposed && savedSinceLive(skill.live, provenance)
  )
  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      // Saving is rare, so its code loads when Save is pressed.
      const { performLibraryAction } = await import("@/lib/library-actions")
      for (const entry of changed) {
        const version = provenance?.versionId
        if (
          !(await performLibraryAction(queryClient, {
            kind: "save",
            entry,
            ...(version ? { version } : {}),
          }))
        )
          break
      }
      // The page names the versions now live.
      await queryClient.invalidateQueries({
        queryKey: documentQueryKeys.page(spaceId, docPath),
        exact: true,
      })
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <Link
        to="/library/$"
        params={{ _splat: skills[0]?.id ?? "" }}
        className={DOCUMENT_BYLINE_CHIP}
      >
        <LibraryIcon className="size-3.5" />
        Skill
      </Link>
      {changed.length > 0 && (
        <Button
          size="xs"
          variant="outline"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      )}
    </>
  )
}
