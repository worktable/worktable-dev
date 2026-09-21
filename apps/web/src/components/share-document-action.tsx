import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Globe2,
  Link2,
  Loader2,
  Share2,
  Unlink,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import { cn } from "@worktable/ui/lib/utils"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import type { PageShareTarget } from "@/hooks/use-page-meta"
import { copyText } from "@/lib/clipboard"
import {
  createDocumentShare,
  getDocumentShare,
  shareQueryKey,
  stopDocumentShare,
  type ShareStatus,
} from "@/lib/share-api"

type CopyState = "idle" | "copied" | "error"

export function ShareDocumentAction({ target }: { target: PageShareTarget }) {
  const deployment = useDeploymentInfo()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [copyState, setCopyState] = useState<CopyState>("idle")
  const [announcement, setAnnouncement] = useState("")
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const available = deployment.data?.capabilities.documentSharing === true
  const queryKey = shareQueryKey(target)
  const status = useQuery({
    queryKey,
    queryFn: () => getDocumentShare(target),
    enabled: available,
    staleTime: 10_000,
  })

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

          <ResponsiveDialogBody className="scroll-fade min-h-28 space-y-3">
            <ShareAccessCard
              state={
                status.isPending
                  ? "loading"
                  : status.isError
                    ? "error"
                    : shared
                      ? "active"
                      : "inactive"
              }
            />

            {target.kind === "html" ? <HtmlSafetyNote /> : null}

            {status.isError ? (
              <InlineError>
                Couldn’t check whether this document is shared.
              </InlineError>
            ) : null}
            {create.isError ? (
              <InlineError>Couldn’t create the link. Try again.</InlineError>
            ) : null}

            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none",
                shared
                  ? "grid-rows-[1fr] opacity-100"
                  : "pointer-events-none grid-rows-[0fr] opacity-0"
              )}
              aria-hidden={!shared}
            >
              <div className="min-h-0 overflow-hidden">
                {share ? (
                  <div className="space-y-2 pt-1">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        id="document-share-url"
                        aria-label="Share link"
                        value={share.url}
                        readOnly
                        className="min-w-0 flex-1 font-mono text-xs"
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <Button
                        type="button"
                        className="h-11 sm:h-10"
                        variant={copyState === "copied" ? "secondary" : "default"}
                        aria-label={
                          copyState === "copied" ? "Copied" : "Copy link"
                        }
                        onClick={() => void handleCopy()}
                      >
                        {copyState === "copied" ? (
                          <Check className="size-4" />
                        ) : (
                          <Copy className="size-4" />
                        )}
                        {copyState === "copied" ? "Copied" : "Copy"}
                      </Button>
                    </div>

                    {copyState === "error" ? (
                      <p className="px-1 text-xs leading-5 text-destructive">
                        Select the link and copy it manually.
                      </p>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      <Button
                        nativeButton={false}
                        render={
                          <a
                            href={share.url}
                            target="_blank"
                            rel="noreferrer"
                            tabIndex={shared ? 0 : -1}
                          />
                        }
                        variant="ghost"
                        className="h-11 px-2 text-primary-text sm:h-9"
                        aria-label="Open shared document"
                      >
                        Open
                        <ExternalLink className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className={cn(
                          "h-11 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive sm:h-9",
                          confirmingStop && "invisible"
                        )}
                        onClick={() => {
                          setConfirmingStop(true)
                          stop.reset()
                        }}
                        hidden={confirmingStop}
                        disabled={stopping || confirmingStop}
                      >
                        <Unlink className="size-3.5" />
                        Stop sharing
                      </Button>
                    </div>
                    {target.kind === "doc" ? (
                      <p className="px-1 pt-1 text-xs leading-5 text-muted-foreground">
                        You’ll need a new link if you move or rename this
                        document.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
                confirmingStop
                  ? "grid-rows-[1fr] opacity-100"
                  : "pointer-events-none grid-rows-[0fr] opacity-0"
              )}
              aria-hidden={!confirmingStop}
            >
              <div className="min-h-0 overflow-hidden">
                <section
                  aria-labelledby="stop-sharing-title"
                  className="mt-1 rounded-xl bg-destructive/10 p-4"
                >
                  <div className="flex items-start gap-3">
                    <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <div>
                      <h3
                        id="stop-sharing-title"
                        className="text-sm font-medium text-foreground"
                      >
                        Stop this link?
                      </h3>
                      <p className="mt-1 text-sm leading-5 text-muted-foreground">
                        It will stop working immediately. Sharing again creates
                        a new link.
                      </p>
                    </div>
                  </div>
                  {stop.isError ? (
                    <p className="mt-3 text-sm text-destructive" role="alert">
                      Couldn’t stop sharing. Try again.
                    </p>
                  ) : null}
                </section>
              </div>
            </div>

            <p className="sr-only" aria-live="polite" aria-atomic="true">
              {announcement}
            </p>
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter className="min-h-14 sm:min-h-14">
            {status.isPending ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
              >
                Close
              </Button>
            ) : status.isError ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void status.refetch()}
                  disabled={status.isFetching}
                >
                  {status.isFetching ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  {status.isFetching ? "Checking…" : "Try again"}
                </Button>
              </>
            ) : confirmingStop ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setConfirmingStop(false)
                    stop.reset()
                  }}
                  disabled={stopping}
                >
                  Keep sharing
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => stop.mutate()}
                  disabled={stopping}
                >
                  {stopping ? <Loader2 className="size-4 animate-spin" /> : null}
                  {stopping ? "Stopping…" : "Stop sharing"}
                </Button>
              </>
            ) : shared ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
              >
                Done
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                  disabled={creating}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => create.mutate()}
                  disabled={creating}
                >
                  {creating ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Link2 className="size-4" />
                  )}
                  {creating ? "Creating…" : "Create link"}
                </Button>
              </>
            )}
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}

function ShareAccessCard({
  state,
}: {
  state: "loading" | "error" | "inactive" | "active"
}) {
  const label = {
    loading: "Checking…",
    error: "Unavailable",
    inactive: "Not shared",
    active: "Active",
  }[state]

  return (
    <div className="rounded-xl bg-surface-tint p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-card text-primary">
          <Globe2 className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            Anyone with the link
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            View only · No sign-in required
          </p>
        </div>
        <span
          className={cn(
            "inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium",
            state === "active" && "bg-success/10 text-success",
            state === "error" && "bg-destructive/10 text-destructive",
            (state === "inactive" || state === "loading") &&
              "bg-muted text-muted-foreground"
          )}
          role={state === "loading" ? "status" : undefined}
        >
          {state === "loading" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <span
              className={cn(
                "size-1.5 rounded-full bg-current",
                state === "inactive" && "opacity-50"
              )}
            />
          )}
          {label}
        </span>
      </div>
    </div>
  )
}

function InlineError({ children }: { children: React.ReactNode }) {
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

function HtmlSafetyNote() {
  return (
    <p className="px-1 text-xs leading-5 text-muted-foreground">
      Records and links to other Worktable content aren’t available in shared
      HTML docs.
    </p>
  )
}
