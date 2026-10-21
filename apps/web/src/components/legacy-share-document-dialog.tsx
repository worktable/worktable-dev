import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  Unlink,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import {
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
} from "@worktable/ui/components/responsive-dialog"
import { cn } from "@worktable/ui/lib/utils"
import {
  HtmlSafetyNote,
  InlineError,
  ShareAccessCard,
} from "./share-document-notes"
import type { useDocumentShareStatus } from "@/hooks/use-document-share"
import type { PageShareTarget } from "@/hooks/use-page-meta"
import type { ShareStatus } from "@/lib/share-api"

interface Mutation {
  isError: boolean
  isPending: boolean
  mutate: () => void
  reset: () => void
}

/** Only the dialog's presentation is deferred; its controller and query stay put. */
export function LegacyShareDocumentDialogContents({
  target,
  status,
  create,
  stop,
  share,
  copyState,
  confirmingStop,
  setConfirmingStop,
  announcement,
  onOpenChange,
  onCopy,
}: {
  target: PageShareTarget
  status: ReturnType<typeof useDocumentShareStatus>
  create: Mutation
  stop: Mutation
  share: ShareStatus["share"]
  copyState: "idle" | "copied" | "error"
  confirmingStop: boolean
  setConfirmingStop: (value: boolean) => void
  announcement: string
  onOpenChange: (open: boolean) => void
  onCopy: () => Promise<void>
}) {
  const shared = share !== null
  const creating = create.isPending
  const stopping = stop.isPending
  return (
    <>
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
                    aria-label={copyState === "copied" ? "Copied" : "Copy link"}
                    onClick={() => void onCopy()}
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
                    You’ll need a new link if you move or rename this document.
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
                    It will stop working immediately. Sharing again creates a
                    new link.
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
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        ) : status.isError ? (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
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
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
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
    </>
  )
}
