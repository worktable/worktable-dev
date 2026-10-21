import { useEffect, useRef, useState } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Globe2,
  Link2,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Share2,
  Unlink,
} from "lucide-react"
import type {
  CreatedShareLink,
  DocumentPageResult,
  DocumentShareLinks,
  DocumentSharingSummary,
  ShareLink,
} from "@worktable/types"
import { SHARE_LINK_LABEL_MAX_LENGTH } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { CopyField } from "@worktable/ui/components/copy-field"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { Input } from "@worktable/ui/components/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@worktable/ui/components/item"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { Skeleton } from "@worktable/ui/components/skeleton"
import { cn } from "@worktable/ui/lib/utils"
import { useDocumentSharingAvailable } from "@/hooks/use-deployment-info"
import {
  useDocumentShareStatus,
  useShareMode,
} from "@/hooks/use-document-share"
import type { PageShareTarget } from "@/hooks/use-page-meta"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { copyText } from "@/lib/clipboard"
import { documentQueryKeys } from "@/lib/documents-queries"
import {
  allowedShareLinkExpiry,
  createBlockedMessage,
  openShareLinkCount,
  SHARE_LINK_LEVEL_LABELS,
  shareLinkDetails,
  shareLinkExpiresAt,
  shareLinkExpiryChoices,
  type ShareLinkExpiry,
} from "@/lib/share-links"
import {
  createDocumentShare,
  createShareLink,
  getDocumentShareLinks,
  revokeShareLink,
  shareLinksQueryKey,
  shareQueryKey,
  stopDocumentShare,
  updateShareLink,
  type ShareStatus,
} from "@/lib/share-api"

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
  if (mode === "links" && props.target.links) {
    return <ShareLinksAction {...props} summary={props.target.links} />
  }
  if (mode === "legacy") return <LegacyShareDocumentAction {...props} />
  return null
}

// ── Links (v2) ───────────────────────────────────────────────

interface LinkDraft {
  label: string
  expiry: ShareLinkExpiry
}

const NEW_LINK: LinkDraft = { label: "", expiry: "never" }

type Editing = { kind: "new" } | { kind: "edit"; link: ShareLink } | null

/** Keep the page's count of open links in step with the dialog's list. */
function notePageLinks(
  queryClient: QueryClient,
  spaceId: string,
  path: string,
  links: readonly ShareLink[]
): void {
  const activeLinks = openShareLinkCount(links)
  queryClient.setQueryData<DocumentPageResult>(
    documentQueryKeys.page(spaceId, path),
    (page) =>
      page?.kind === "document" &&
      page.sharing &&
      page.sharing.activeLinks !== activeLinks
        ? { ...page, sharing: { ...page.sharing, activeLinks } }
        : undefined
  )
}

function ShareLinksAction({
  target,
  summary,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: ShareDocumentActionProps & { summary: DocumentSharingSummary }) {
  const queryClient = useQueryClient()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const { spaceId, artifactKey: path } = target
  const queryKey = shareLinksQueryKey(spaceId, path)
  // Read when the dialog opens, never before and never on a timer.
  const list = useQuery({
    queryKey,
    queryFn: () => getDocumentShareLinks({ kind: target.kind, spaceId, path }),
    enabled: open,
  })
  const [editing, setEditing] = useState<Editing>(null)
  const [draft, setDraft] = useState<LinkDraft>(NEW_LINK)
  const [created, setCreated] = useState<CreatedShareLink | null>(null)
  const [revoking, setRevoking] = useState<ShareLink | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const scrollRef = useScrollFade<HTMLDivElement>()

  // Each opening starts afresh; one with no open links starts a new link.
  const [shownOpen, setShownOpen] = useState(false)
  if (shownOpen !== open) {
    setShownOpen(open)
    if (open) {
      setEditing(
        summary.activeLinks === 0 && summary.canCreate ? { kind: "new" } : null
      )
      setDraft(NEW_LINK)
      setCreated(null)
      setAnnouncement("")
    }
  }

  const links = list.data?.links
  useEffect(() => {
    if (links) notePageLinks(queryClient, spaceId, path, links)
  }, [links, path, queryClient, spaceId])

  function writeLinks(update: (links: ShareLink[]) => ShareLink[]) {
    const next = queryClient.setQueryData<DocumentShareLinks>(
      queryKey,
      (current) =>
        current ? { ...current, links: update(current.links) } : current
    )
    if (next) notePageLinks(queryClient, spaceId, path, next.links)
  }

  const create = useMutation({
    mutationFn: (input: LinkDraft) =>
      createShareLink({
        target: { kind: target.kind, spaceId, path },
        label: input.label.trim(),
        expiresAt: shareLinkExpiresAt(input.expiry) ?? null,
      }),
    onSuccess: (result) => {
      writeLinks((current) => [
        result.link,
        ...current.filter((link) => link.id !== result.link.id),
      ])
      setCreated(result)
      setEditing(null)
      setDraft(NEW_LINK)
      setAnnouncement("Link created. Copy it now.")
    },
  })
  const update = useMutation({
    mutationFn: ({ link, input }: { link: ShareLink; input: LinkDraft }) => {
      const expiresAt = shareLinkExpiresAt(input.expiry)
      return updateShareLink(link.id, {
        label: input.label.trim(),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      })
    },
    onSuccess: ({ link }) => {
      writeLinks((current) =>
        current.map((candidate) =>
          candidate.id === link.id ? link : candidate
        )
      )
      setEditing(null)
      setDraft(NEW_LINK)
      setAnnouncement("Link saved")
    },
  })
  const revoke = useMutation({
    mutationFn: (link: ShareLink) => revokeShareLink(link.id),
    onSuccess: (_result, link) => {
      writeLinks((current) =>
        current.filter((candidate) => candidate.id !== link.id)
      )
      if (created?.link.id === link.id) setCreated(null)
      if (editing?.kind === "edit" && editing.link.id === link.id) {
        setEditing(null)
      }
      setRevoking(null)
      setAnnouncement("Link revoked")
    },
  })

  const saving = create.isPending || update.isPending
  // A new link waits for the list, which shows its URL once made.
  const ready = editing?.kind !== "new" || list.data !== undefined
  const canCreate = list.data?.canCreate ?? summary.canCreate
  const editingLink = editing?.kind === "edit" ? editing.link : null
  const choices = shareLinkExpiryChoices(list.data?.policy, editingLink)
  const expiry = allowedShareLinkExpiry(draft.expiry, choices)
  const formShown =
    editing !== null && !list.isError && (editing.kind === "edit" || canCreate)
  const active = summary.activeLinks

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && (saving || revoke.isPending)) return
    setOpen(nextOpen)
    if (nextOpen) return
    setEditing(null)
    setCreated(null)
    setRevoking(null)
    create.reset()
    update.reset()
    revoke.reset()
  }

  function startEditing(next: Editing) {
    setEditing(next)
    create.reset()
    update.reset()
    setDraft(
      next?.kind === "edit"
        ? {
            label: next.link.label,
            expiry: next.link.expiresAt ? "keep" : "never",
          }
        : NEW_LINK
    )
  }

  function cancelEditing() {
    // With nothing else to show, cancelling a new link closes the dialog.
    if (editing?.kind === "new" && (links?.length ?? 0) === 0 && !created) {
      handleOpenChange(false)
      return
    }
    startEditing(null)
  }

  function submit() {
    if (saving || !ready || !editing) return
    const input = { ...draft, expiry }
    if (editing.kind === "new") create.mutate(input)
    else update.mutate({ link: editing.link, input })
  }

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

      <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
        <ResponsiveDialogContent className="sm:max-w-md">
          <ResponsiveDialogHeader>
            <div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-surface-tint text-primary">
              <Link2 className="size-5" />
            </div>
            <ResponsiveDialogTitle>Share document</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Anyone with a link can open this document without signing in.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <ResponsiveDialogBody
            ref={scrollRef}
            className="scroll-fade min-h-28 space-y-3"
          >
            {list.data && !list.data.canCreate ? (
              <Callout>
                {createBlockedMessage(list.data.createBlockedBy)}
              </Callout>
            ) : null}

            {list.isError ? (
              <InlineError>Couldn’t load this document’s links.</InlineError>
            ) : links ? (
              links.length > 0 ? (
                <ShareLinkList
                  links={links}
                  created={created}
                  editingId={editingLink?.id ?? null}
                  disabled={saving}
                  onEdit={(link) => startEditing({ kind: "edit", link })}
                  onRevoke={(link) => {
                    revoke.reset()
                    setRevoking(link)
                  }}
                  onCopied={() => setAnnouncement("Link copied")}
                />
              ) : null
            ) : active > 0 ? (
              <ShareLinkListSkeleton rows={Math.min(active, 3)} />
            ) : null}

            {formShown ? (
              <ShareLinkForm
                draft={{ ...draft, expiry }}
                onChange={setDraft}
                choices={choices}
                disabled={saving}
                onSubmit={submit}
              />
            ) : canCreate && !list.isError && list.data ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => startEditing({ kind: "new" })}
              >
                <Plus className="size-4" />
                New link
              </Button>
            ) : null}

            {create.isError ? (
              <InlineError>Couldn’t create the link. Try again.</InlineError>
            ) : null}
            {update.isError ? (
              <InlineError>Couldn’t save the link. Try again.</InlineError>
            ) : null}

            {target.kind === "html" ? <HtmlSafetyNote /> : null}

            <p className="sr-only" aria-live="polite" aria-atomic="true">
              {announcement}
            </p>
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter className="min-h-14 sm:min-h-14">
            {formShown ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={cancelEditing}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  form="share-link-form"
                  disabled={saving || !ready}
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  {editing?.kind === "edit"
                    ? saving
                      ? "Saving…"
                      : "Save"
                    : saving
                      ? "Creating…"
                      : "Create link"}
                </Button>
              </>
            ) : list.isError ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Close
                </Button>
                <Button
                  type="button"
                  onClick={() => void list.refetch()}
                  disabled={list.isFetching}
                >
                  {list.isFetching ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  {list.isFetching ? "Checking…" : "Try again"}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
              >
                Done
              </Button>
            )}
          </ResponsiveDialogFooter>

          {/* Nested, so answering it never counts as leaving the dialog. */}
          <ConfirmDialog
            open={revoking !== null}
            onOpenChange={(next) => {
              if (!next) setRevoking(null)
            }}
            title="Revoke this link?"
            description="It stops working immediately."
            confirmLabel="Revoke"
            variant="destructive"
            icon={<Unlink className="size-5 text-destructive" />}
            loading={revoke.isPending}
            loadingLabel="Revoking…"
            onConfirm={() => {
              if (revoking) revoke.mutate(revoking)
            }}
          >
            {revoke.isError ? (
              <InlineError>Couldn’t revoke the link. Try again.</InlineError>
            ) : null}
          </ConfirmDialog>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}

/** A document's links, each with what it allows and when it was last used. */
export function ShareLinkList({
  links,
  created,
  editingId,
  disabled,
  onEdit,
  onRevoke,
  onCopied,
}: {
  links: readonly ShareLink[]
  /** The link just made: its URL shows this once. */
  created: CreatedShareLink | null
  editingId: string | null
  disabled: boolean
  onEdit: (link: ShareLink) => void
  onRevoke: (link: ShareLink) => void
  onCopied: () => void
}) {
  return (
    <ItemGroup aria-label="Links" className="gap-0 rounded-xl card-surface p-1">
      {links.map((link) => {
        const name = link.label || "Untitled link"
        const url = created?.link.id === link.id ? created.url : null
        return (
          <Item
            key={link.id}
            role="listitem"
            size="sm"
            className={cn(
              "flex-nowrap gap-3 py-2 pr-1.5",
              url && "flex-wrap",
              link.id === editingId && "bg-surface-selected"
            )}
          >
            <ItemContent className="min-w-0 gap-0.5">
              <ItemTitle className="w-full truncate">
                <span className="truncate">{name}</span>
              </ItemTitle>
              <ItemDescription className="text-xs">
                {shareLinkDetails(link).map((part, index) => (
                  <span key={part.text}>
                    {index > 0 ? " · " : null}
                    <span
                      className={cn(
                        "whitespace-nowrap",
                        part.stopped && "text-destructive"
                      )}
                    >
                      {part.text}
                    </span>
                  </span>
                ))}
              </ItemDescription>
            </ItemContent>
            {link.canManage ? (
              <ItemActions>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={disabled}
                        aria-label={`Actions for ${name}`}
                      />
                    }
                  >
                    <MoreVertical className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-40">
                    <DropdownMenuItem onClick={() => onEdit(link)}>
                      <Pencil className="mr-2 size-4" />
                      Edit Link
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onRevoke(link)}
                    >
                      <Unlink className="mr-2 size-4" />
                      Revoke Link
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </ItemActions>
            ) : null}
            {url ? (
              <div className="min-w-0 basis-full space-y-1.5 pt-1 pb-1">
                <CopyField value={url} onCopied={onCopied} />
                <p className="px-1 text-xs text-muted-foreground">
                  Copy it now. It won’t be shown again.
                </p>
              </div>
            ) : null}
          </Item>
        )
      })}
    </ItemGroup>
  )
}

function ShareLinkListSkeleton({ rows }: { rows: number }) {
  return (
    <div
      className="space-y-1 rounded-xl card-surface p-1"
      role="status"
      aria-label="Loading links"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="space-y-1.5 px-3 py-2.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-52" />
        </div>
      ))}
    </div>
  )
}

function ShareLinkForm({
  draft,
  onChange,
  choices,
  disabled,
  onSubmit,
}: {
  draft: LinkDraft
  onChange: (draft: LinkDraft) => void
  choices: Array<{ value: ShareLinkExpiry; label: string }>
  disabled: boolean
  onSubmit: () => void
}) {
  const expiryLabel =
    choices.find((choice) => choice.value === draft.expiry)?.label ?? ""
  return (
    <form
      id="share-link-form"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="space-y-2">
        <label htmlFor="share-link-label" className="text-sm font-medium">
          Label
        </label>
        <Input
          id="share-link-label"
          placeholder="Who is it for?"
          maxLength={SHARE_LINK_LABEL_MAX_LENGTH}
          value={draft.label}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, label: event.target.value })
          }
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <span id="share-link-access" className="block text-sm font-medium">
            Access
          </span>
          <Select value="view" disabled={disabled}>
            <SelectTrigger
              aria-labelledby="share-link-access"
              className="h-10 w-full"
            >
              <SelectValue>{SHARE_LINK_LEVEL_LABELS.view}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="view">
                {SHARE_LINK_LEVEL_LABELS.view}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <span id="share-link-expires" className="block text-sm font-medium">
            Expires
          </span>
          <Select
            value={draft.expiry}
            disabled={disabled}
            onValueChange={(expiry) => {
              if (expiry) onChange({ ...draft, expiry })
            }}
          >
            <SelectTrigger
              aria-labelledby="share-link-expires"
              className="h-10 w-full"
            >
              <SelectValue>{expiryLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {choices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </form>
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
