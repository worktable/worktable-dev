import { lazy, useEffect, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, Link2, Share2 } from "lucide-react"
import type { DocumentSharingSummary } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import { useDocumentSharingAvailable } from "@/hooks/use-deployment-info"
import {
  useDocumentShareStatus,
  useShareMode,
} from "@/hooks/use-document-share"
import type { PageShareTarget } from "@/hooks/use-page-meta"
import { copyText } from "@/lib/clipboard"
import {
  createDocumentShare,
  shareQueryKey,
  stopDocumentShare,
  type ShareStatus,
} from "@/lib/share-api"

// Loaded when first opened, like New Space.
const ShareLinksDialog = lazy(() =>
  import("@/components/share-links-dialog").then((module) => ({
    default: module.ShareLinksDialog,
  }))
)

const LegacyShareDocumentDialogContents = lazy(() =>
  import("@/components/share-links-dialog").then((module) => ({
    default: module.LegacyShareDocumentDialogContents,
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

// ── Today's single link ──────────────────────────────────────

type CopyState = "idle" | "copied" | "error"

function LegacyShareDocumentAction({
  target,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: {
  target: PageShareTarget
  /** Lets another control, such as the narrow-screen page menu, open it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  showTrigger?: boolean
}) {
  const queryClient = useQueryClient()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [copyState, setCopyState] = useState<CopyState>("idle")
  const [announcement, setAnnouncement] = useState("")
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const available = useDocumentSharingAvailable()
  const queryKey = shareQueryKey(target)
  const status = useDocumentShareStatus(target)

  const create = useMutation({
    mutationFn: () => createDocumentShare(target),
    onMutate: () => {
      setAnnouncement("")
      setCopyState("idle")
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result)
      setAnnouncement("Link ready")
    },
  })
  const stop = useMutation({
    mutationFn: () => stopDocumentShare(target),
    onSuccess: () => {
      queryClient.setQueryData<ShareStatus>(queryKey, { share: null })
      setConfirmingStop(false)
      setCopyState("idle")
      setAnnouncement("Sharing stopped")
    },
  })

  useEffect(
    () => () => {
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current)
    },
    []
  )

  if (!available) return null

  const share = status.data?.share ?? null
  const shared = share !== null
  const creating = create.isPending
  const stopping = stop.isPending

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && (creating || stopping)) return
    setOpen(nextOpen)
    if (nextOpen) return
    setConfirmingStop(false)
    setCopyState("idle")
    setAnnouncement("")
    create.reset()
    stop.reset()
  }

  async function handleCopy() {
    if (!share) return
    try {
      await copyText(share.url)
      setCopyState("copied")
      setAnnouncement("Link copied")
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current)
      copyResetTimerRef.current = setTimeout(() => {
        setCopyState("idle")
        setAnnouncement("")
      }, 1_800)
    } catch (error) {
      console.error("Share link copy failed:", error)
      setCopyState("error")
      setAnnouncement("Couldn’t copy the link")
    }
  }

  return (
    <>
      {showTrigger && (
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
      )}

      <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
        <ResponsiveDialogContent className="sm:max-w-md">
          <ResponsiveDialogHeader>
            <div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-surface-tint text-primary">
              <Link2 className="size-5" />
            </div>
            <ResponsiveDialogTitle>Share document</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Manage a view-only link for this document.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <DeferredMount active={open}>
            <LegacyShareDocumentDialogContents
              target={target}
              status={status}
              create={create}
              stop={stop}
              share={share}
              copyState={copyState}
              confirmingStop={confirmingStop}
              setConfirmingStop={setConfirmingStop}
              announcement={announcement}
              onOpenChange={handleOpenChange}
              onCopy={handleCopy}
            />
          </DeferredMount>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}
