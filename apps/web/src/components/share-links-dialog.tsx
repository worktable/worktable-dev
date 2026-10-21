import { useEffect, useState } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import {
  Link2,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Unlink,
} from "lucide-react"
import type {
  CreatedShareLink,
  DocumentPageResult,
  DocumentShareLinks,
  DocumentSharingSummary,
  ShareLink,
} from "@worktable/types"
import { SHARE_LINK_LABEL_MAX_LENGTH } from "@worktable/types/constants"
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
import { HtmlSafetyNote, InlineError } from "@/components/share-document-action"
import type { PageShareTarget } from "@/hooks/use-page-meta"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { documentQueryKeys } from "@/lib/documents-queries"
import { useWorkspace } from "@/lib/queries"
import { openSettings } from "@/lib/settings-open"
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
  createShareLink,
  getDocumentShareLinks,
  revokeShareLink,
  shareLinksQueryKey,
  updateShareLink,
} from "@/lib/share-api"

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

/**
 * The share dialog while links v2 is on: a document's links, a form for a
 * new or edited one, and revoking. Loaded when the page's Share is first
 * opened.
 */
export function ShareLinksDialog({
  target,
  summary,
  open,
  onOpenChange: setOpen,
}: {
  target: PageShareTarget
  summary: DocumentSharingSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
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
  // Owners can lift a pause or allow the Space from Settings → Links.
  const owner = useWorkspace().data?.person?.role === "owner"

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
                <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span>{createBlockedMessage(list.data.createBlockedBy)}</span>
                  {owner &&
                  (list.data.createBlockedBy === "paused" ||
                    list.data.createBlockedBy === "space") ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        handleOpenChange(false)
                        openSettings("links")
                      }}
                    >
                      Manage Links
                    </Button>
                  ) : null}
                </span>
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
