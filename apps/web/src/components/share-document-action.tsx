import { lazy, useEffect, useState } from "react"
import { useLocation, useNavigate } from "@tanstack/react-router"
import { AlertCircle, Check, Share2 } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import { useShareMode } from "@/hooks/use-document-share"
import type { PageShareTarget } from "@/hooks/use-page-meta"

// Loaded when first opened, like New Space.
const ShareLinksDialog = lazy(() =>
  import("@/components/share-links-dialog").then((module) => ({
    default: module.ShareLinksDialog,
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
 * The page's Share button, which says whether links are open, and its
 * share dialog.
 */
export function ShareDocumentAction(props: ShareDocumentActionProps) {
  return useShareMode(props.target) ? <ShareLinksAction {...props} /> : null
}

function ShareLinksAction({
  target,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: ShareDocumentActionProps) {
  const summary = target.links
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const active = summary.activeLinks
  // Home's Try Next arrives with #share to open this dialog once.
  const hash = useLocation({ select: (location) => location.hash })
  const navigate = useNavigate()
  useEffect(() => {
    if (hash !== "share") return
    setOpen(true)
    void navigate({ hash: "", replace: true, resetScroll: false })
    // Opened once on arrival; setOpen changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, navigate])

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

export function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
      role="alert"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  )
}

export function HtmlSafetyNote() {
  return (
    <p className="px-1 text-xs leading-5 text-muted-foreground">
      Records and links to other Worktable content aren’t available in shared
      HTML docs.
    </p>
  )
}
