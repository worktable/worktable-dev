import { lazy, useState } from "react"
import { Check, Share2 } from "lucide-react"
import type { DocumentSharingSummary } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import {
  useDocumentShareStatus,
  useShareMode,
} from "@/hooks/use-document-share"
import type { PageShareTarget } from "@/hooks/use-page-meta"

// Loaded when first opened, like New Space.
const ShareLinksDialog = lazy(() =>
  import("@/components/share-links-dialog").then((module) => ({
    default: module.ShareLinksDialog,
  }))
)

const LegacyShareDocumentDialog = lazy(() =>
  import("@/components/share-links-dialog").then((module) => ({
    default: module.LegacyShareDocumentDialog,
  }))
)

interface ShareDocumentActionProps {
  target: PageShareTarget
  /** Lets another control, such as the narrow-screen page menu, open it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  showTrigger?: boolean
}

/**
 * The page's Share button and dialog: several labelled links per document
 * while links v2 is on, today's single link otherwise.
 */
export function ShareDocumentAction(props: ShareDocumentActionProps) {
  const mode = useShareMode(props.target)
  if (mode === "links") {
    return (
      <ShareLinksAction
        {...props}
        summary={props.target.links ?? UNREAD_SUMMARY}
      />
    )
  }
  if (mode === "legacy") return <LegacyShareDocumentAction {...props} />
  return null
}

// ── Links (v2) ───────────────────────────────────────────────

/**
 * For a page read before links v2 was on: the dialog's list says how many
 * links there are once it opens.
 */
const UNREAD_SUMMARY: DocumentSharingSummary = {
  activeLinks: 0,
  canCreate: true,
}

/** The page's Share button, which says whether links are open. */
function ShareLinksAction({
  target,
  summary,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: ShareDocumentActionProps & { summary: DocumentSharingSummary }) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const active = summary.activeLinks

  return (
    <>
      {showTrigger && (
        <Button
          type="button"
          size="xs"
          variant={active > 0 ? "secondary" : "outline"}
          className="shrink-0"
          aria-label="Share document"
          title={
            active === 0
              ? "Share document"
              : active === 1
                ? "Share link active"
                : `${active} share links active`
          }
          onClick={() => setOpen(true)}
        >
          {active > 0 ? (
            <Check className="size-3.5" />
          ) : (
            <Share2 className="size-3.5" />
          )}
          <span className="hidden sm:inline">Share</span>
        </Button>
      )}

      <DeferredMount active={open}>
        <ShareLinksDialog
          key={`${target.kind}:${target.spaceId}:${target.artifactKey}`}
          target={target}
          summary={summary}
          open={open}
          onOpenChange={setOpen}
        />
      </DeferredMount>
    </>
  )
}

/** The existing single-link trigger; dialog code waits until it opens. */
function LegacyShareDocumentAction({
  target,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: ShareDocumentActionProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const status = useDocumentShareStatus(target)
  const shared = status.data?.share != null
  return (
    <>
      {showTrigger ? (
        <Button
          type="button"
          size="xs"
          variant={shared ? "secondary" : "outline"}
          className="shrink-0"
          aria-label="Share document"
          title={shared ? "Share link active" : "Share document"}
          onClick={() => setOpen(true)}
        >
          {shared ? (
            <Check className="size-3.5" />
          ) : (
            <Share2 className="size-3.5" />
          )}
          <span className="hidden sm:inline">Share</span>
        </Button>
      ) : null}
      <DeferredMount active={open}>
        <LegacyShareDocumentDialog
          target={target}
          open={open}
          onOpenChange={setOpen}
          status={status}
        />
      </DeferredMount>
    </>
  )
}
