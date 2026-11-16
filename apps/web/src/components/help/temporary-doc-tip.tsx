import { useState } from "react"
import { Infinity as InfinityIcon } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { TipCard } from "@/components/help/help-tip"
import { useLifetimeActions } from "@/hooks/use-document-organize"
import { TIPS } from "@/lib/help/registry"
import { formatArchiveDate, useDocumentSummary } from "@/lib/lifetime"
import { useSpace } from "@/lib/queries"

/**
 * The first temporary Doc a person opens says when it archives, with Keep
 * right there. Keeping it finishes the tip.
 */
export function TemporaryDocTip({
  spaceId,
  path,
}: {
  spaceId: string
  path: string
}) {
  const { data: space } = useSpace(spaceId)
  const summary = useDocumentSummary(spaceId, path)
  const { keep } = useLifetimeActions(spaceId, path)
  const [keeping, setKeeping] = useState(false)
  const archiveOn =
    summary?.lifetime === "temporary" && !summary.archived
      ? summary.archiveOn
      : undefined
  const canKeep = space?.space.permissions?.edit !== false
  return (
    <TipCard
      tip={TIPS.temporaryDoc}
      active={Boolean(archiveOn) && canKeep}
      values={archiveOn ? { date: formatArchiveDate(archiveOn) } : undefined}
      className="mt-3"
      actions={(done) => (
        <Button
          size="sm"
          disabled={keeping}
          onClick={() => {
            setKeeping(true)
            void keep()
              .then((kept) => {
                if (kept) done()
              })
              .finally(() => setKeeping(false))
          }}
        >
          <InfinityIcon />
          Keep
        </Button>
      )}
    />
  )
}
