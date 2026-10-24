import { useEffect, useId, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy, Loader2, MoreVertical, Pencil, Plus, Unlink } from "lucide-react"
import type {
  DocumentShareLinks,
  DocumentSharingSummary,
  LinkGrant,
  ShareLink,
  ShareLinkAccess,
  SharerPolicy,
  UpdateShareLinkInput,
} from "@worktable/types"
import { DEFAULT_SHARE_LINK_COMMENT_SETTINGS } from "@worktable/types"
import { SHARE_LINK_LABEL_MAX_LENGTH } from "@worktable/types/constants"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { Disclosure } from "@worktable/ui/components/disclosure"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { SettingRow } from "@worktable/ui/components/setting-row"
import { Skeleton } from "@worktable/ui/components/skeleton"
import { Switch } from "@worktable/ui/components/switch"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { cn } from "@worktable/ui/lib/utils"
import { LiveDataPanel } from "@/components/share-link-access"
import { HtmlSafetyNote, InlineError } from "@/components/share-document-action"
import { useBreadcrumbs } from "@/hooks/use-breadcrumbs"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import type { PageShareTarget } from "@/hooks/use-page-meta"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { notePageLinks } from "@/lib/sharing-cache"
import { useWorkspace } from "@/lib/queries"
import { openSettings } from "@/lib/settings-open"
import {
  allowedShareLinkExpiry,
  copyShareLink,
  createBlockedMessage,
  defaultShareLink,
  defaultShareLinkExpiry,
  otherCurrentLinkCount,
  shareLinkExpiresAt,
  shareLinkExpiryChoices,
  shareLinkSummary,
  type ShareLinkDetail,
  type ShareLinkExpiry,
} from "@/lib/share-links"
import {
  createShareLink,
  getDocumentShareLinks,
  revokeShareLink,
  shareLinksQueryKey,
  updateShareLink,
} from "@/lib/share-link-management-api"
import {
  checkShareLinkAccess,
  retryOnPreviewChange,
} from "@/lib/share-link-access-api"

interface LinkDraft {
  label: string
  expiry: ShareLinkExpiry
  passwordEnabled: boolean
  password: string
}

/**
 * `default` makes the first link when the owner policy needs a password for
 * it; `new` makes a labelled link under More links.
 */
type Editing =
  | { kind: "default" }
  | { kind: "new" }
  | { kind: "edit"; link: ShareLink }
  | null

function newDraft(policy: SharerPolicy | undefined): LinkDraft {
  return {
    label: "",
    expiry: defaultShareLinkExpiry(policy),
    passwordEnabled: false,
    password: "",
  }
}

function linkName(link: ShareLink): string {
  return link.label || "Untitled link"
}

/**
 * The share dialog: the document's default link to copy, its live data and
 * comments, and any other links. Loaded when the page's Share is first
 * opened; it reads the document's links once per opening.
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
  const preview = useDeploymentInfo().data?.capabilities.sharingPreview === true
  const queryClient = useQueryClient()
  const { spaceId, artifactKey: path } = target
  const shareTarget = { kind: target.kind, spaceId, path }
  const queryKey = shareLinksQueryKey(spaceId, path)
  // Read when the dialog opens, never before and never on a timer.
  const list = useQuery({
    queryKey,
    queryFn: () => getDocumentShareLinks(shareTarget),
    enabled: open,
  })
  const title = [...useBreadcrumbs()]
    .reverse()
    .find((crumb) => crumb.role === "document")?.label
  const [editing, setEditing] = useState<Editing>(null)
  const [draft, setDraft] = useState<LinkDraft>(() => newDraft(undefined))
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null
  )
  const [liveOpen, setLiveOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // Checked access, for the link it was checked for.
  const [access, setAccess] = useState<{
    linkId: string
    access: ShareLinkAccess
  } | null>(null)
  const [revoking, setRevoking] = useState<ShareLink | null>(null)
  const [announcement, setAnnouncement] = useState("")
  // Results from an earlier opening never apply to a later one.
  const session = useRef(0)
  const scrollRef = useScrollFade<HTMLDivElement>()
  // Owners can lift a pause or allow the Space from Settings → Links.
  const owner = useWorkspace().data?.person?.role === "owner"

  const links = list.data?.links
  const policy = list.data?.policy
  const defaultLink = links ? defaultShareLink(links) : null
  const others = links?.filter((link) => link !== defaultLink) ?? []
  const canCreate = list.data?.canCreate ?? summary.canCreate
  const passwordRequired = preview && (policy?.requirePassword ?? false)
  const liveAllowed =
    preview && target.kind === "html" && policy?.liveLinks === true
  const liveShown =
    preview &&
    target.kind === "html" &&
    defaultLink !== null &&
    (policy?.liveLinks === true || defaultLink.grant !== undefined)
  const commentsShown =
    preview &&
    defaultLink !== null &&
    (policy?.levels.includes("comment") === true ||
      defaultLink.level === "comment")
  const checked =
    defaultLink && access?.linkId === defaultLink.id ? access.access : null

  useEffect(() => {
    if (links) notePageLinks(queryClient, spaceId, path, links)
  }, [links, path, queryClient, spaceId])
  // Closing can also come from the page menu or navigation, outside this
  // dialog's own close handler.
  useEffect(() => {
    session.current++
  }, [open])

  function writeLinks(update: (links: ShareLink[]) => ShareLink[]) {
    const next = queryClient.setQueryData<DocumentShareLinks>(
      queryKey,
      (current) =>
        current ? { ...current, links: update(current.links) } : current
    )
    if (next) notePageLinks(queryClient, spaceId, path, next.links)
  }
  function replaceLink(link: ShareLink) {
    writeLinks((current) =>
      current.map((candidate) => (candidate.id === link.id ? link : candidate))
    )
  }

  const create = useMutation({
    mutationFn: (input: LinkDraft) =>
      createShareLink({
        target: shareTarget,
        label: input.label.trim(),
        ...(preview
          ? { level: "view", comments: DEFAULT_SHARE_LINK_COMMENT_SETTINGS }
          : {}),
        expiresAt: shareLinkExpiresAt(input.expiry) ?? null,
        ...(preview && (input.passwordEnabled || passwordRequired)
          ? { password: input.password }
          : {}),
      }),
    onSuccess: (result) => {
      const link = { ...result.link, url: result.link.url ?? result.url }
      writeLinks((current) => [
        link,
        ...current.filter((candidate) => candidate.id !== link.id),
      ])
      setEditing(null)
      setAnnouncement("Link created")
    },
  })
  const update = useMutation({
    mutationFn: ({
      link,
      change,
    }: {
      link: ShareLink
      change: UpdateShareLinkInput
      said: string
      /** Saved from the link form, which closes on success. */
      fromForm?: boolean
    }) =>
      // Saving access is refused while the tool changes; ask once more.
      change.grant
        ? retryOnPreviewChange(() => updateShareLink(link.id, change))
        : updateShareLink(link.id, change),
    onSuccess: ({ link }, { said, fromForm }) => {
      replaceLink(link)
      if (fromForm)
        setEditing((current) =>
          current?.kind === "edit" && current.link.id === link.id
            ? null
            : current
        )
      setAnnouncement(said)
    },
  })
  const revoke = useMutation({
    mutationFn: (link: ShareLink) => revokeShareLink(link.id),
    onSuccess: (_result, link) => {
      writeLinks((current) =>
        current.filter((candidate) => candidate.id !== link.id)
      )
      setEditing((current) =>
        current?.kind === "edit" && current.link.id === link.id ? null : current
      )
      setRevoking(null)
      setAnnouncement("Link revoked")
    },
  })
  // What the default link's live data opens, with counts.
  const check = useMutation({
    mutationFn: ({ link }: { link: ShareLink; session: number }) =>
      retryOnPreviewChange(() =>
        checkShareLinkAccess(shareTarget, {
          grant: link.grant,
          observe: false,
          linkId: link.id,
        })
      ),
    onSuccess: (result, input) => {
      if (input.session === session.current)
        setAccess({ linkId: input.link.id, access: result })
    },
  })
  // Turning live data on saves the access the server suggests for the tool,
  // unless it doesn't fit the tool's collections.
  const turnOn = useMutation({
    mutationFn: ({ link }: { link: ShareLink; session: number }) =>
      retryOnPreviewChange(async () => {
        const result = await checkShareLinkAccess(shareTarget, {
          observe: true,
          linkId: link.id,
        })
        if (result.issues.length > 0) return { access: result, link: null }
        const saved = await updateShareLink(link.id, { grant: result.grant })
        return { access: result, link: saved.link }
      }),
    onSuccess: (result, input) => {
      if (input.session !== session.current) return
      setAccess({ linkId: input.link.id, access: result.access })
      if (!result.link) return
      replaceLink(result.link)
      setAnnouncement("Live data on")
    },
  })
  const busy =
    create.isPending || update.isPending || revoke.isPending || turnOn.isPending

  // Each opening starts afresh.
  const [shownOpen, setShownOpen] = useState(false)
  if (shownOpen !== open) {
    setShownOpen(open)
    if (open) {
      setEditing(null)
      setLiveOpen(false)
      setMoreOpen(false)
      setAccess(null)
      setAnnouncement("")
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && busy) return
    setOpen(nextOpen)
    if (nextOpen) return
    setEditing(null)
    setRevoking(null)
    for (const mutation of [create, update, revoke, check, turnOn])
      mutation.reset()
  }

  function startEditing(next: Editing) {
    create.reset()
    update.reset()
    setEditing(next)
    setDraft(
      next?.kind === "edit"
        ? {
            label: next.link.label,
            expiry: next.link.expiresAt ? "keep" : "never",
            passwordEnabled: next.link.hasPassword,
            password: "",
          }
        : newDraft(policy)
    )
  }

  function createDefault() {
    if (passwordRequired) {
      startEditing({ kind: "default" })
      return
    }
    const expiry = allowedShareLinkExpiry(
      defaultShareLinkExpiry(policy),
      shareLinkExpiryChoices(policy, null)
    )
    create.mutate({ ...newDraft(policy), expiry })
  }

  function openLive(next: boolean) {
    setLiveOpen(next)
    if (
      next &&
      defaultLink?.grant &&
      liveAllowed &&
      !checked &&
      !check.isPending
    )
      check.mutate({ link: defaultLink, session: session.current })
  }

  const editingLink = editing?.kind === "edit" ? editing.link : null
  const choices = shareLinkExpiryChoices(policy, editingLink)

  function submit() {
    if (busy || !editing) return
    const expiry = allowedShareLinkExpiry(draft.expiry, choices)
    if (editing.kind !== "edit") {
      create.mutate({
        ...draft,
        expiry,
        label: editing.kind === "new" ? draft.label : "",
      })
      return
    }
    const link = editing.link
    const expiresAt = shareLinkExpiresAt(expiry)
    update.mutate({
      link,
      said: "Link saved",
      fromForm: true,
      change: {
        ...(link.label ? { label: draft.label.trim() } : {}),
        ...(expiresAt !== undefined && (expiresAt ?? link.expiresAt) !== null
          ? { expiresAt }
          : {}),
        ...(preview
          ? !draft.passwordEnabled && !passwordRequired
            ? link.hasPassword
              ? { password: null }
              : {}
            : draft.password
              ? { password: draft.password }
              : {}
          : {}),
      },
    })
  }

  function form(kind: "default" | "new" | "edit") {
    return (
      <LinkForm
        draft={{
          ...draft,
          expiry: allowedShareLinkExpiry(draft.expiry, choices),
        }}
        onChange={setDraft}
        choices={choices}
        withLabel={kind === "new" || Boolean(editingLink?.label)}
        passwords={preview}
        passwordRequired={passwordRequired}
        hasPassword={editingLink?.hasPassword ?? false}
        busy={busy}
        submitLabel={kind === "edit" ? "Save" : "Create Link"}
        onSubmit={submit}
        onCancel={() => setEditing(null)}
        container={portalContainer}
      />
    )
  }

  function menu(link: ShareLink, label: string) {
    return (
      <LinkMenu
        link={link}
        label={label}
        container={portalContainer}
        disabled={busy}
        onEdit={() => startEditing({ kind: "edit", link })}
        onRevoke={() => {
          revoke.reset()
          setRevoking(link)
        }}
      />
    )
  }

  const moreShown =
    links !== undefined &&
    (others.length > 0 || (canCreate && defaultLink !== null))
  const otherCount = otherCurrentLinkCount(links ?? [], defaultLink)

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent
        ref={setPortalContainer}
        // Vaul captures Escape before a nested Base UI popup dismisses.
        // Keep that popup's first Escape inside this sharing sheet.
        onEscapeKeyDown={(event) => {
          if (
            portalContainer?.querySelector('[data-slot$="-content"][data-open]')
          )
            event.preventDefault()
        }}
        className="overflow-clip sm:max-w-md"
      >
        <ResponsiveDialogHeader className="pb-2">
          <ResponsiveDialogTitle className="truncate">
            {title ? `Share “${title}”` : "Share"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {target.kind === "html"
              ? "Anyone with the link can use this tool"
              : "Anyone with the link can view this document"}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody
          ref={scrollRef}
          className="scroll-fade min-h-16 space-y-4"
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
          ) : !links ? (
            <DefaultLinkSkeleton />
          ) : editing?.kind === "default" ||
            (editingLink && editingLink.id === defaultLink?.id) ? (
            form(editing?.kind === "default" ? "default" : "edit")
          ) : defaultLink ? (
            <DefaultLink
              link={defaultLink}
              menu={menu(defaultLink, "Link actions")}
              onCopied={() => setAnnouncement("Link copied")}
            />
          ) : canCreate ? (
            <Button
              type="button"
              className="w-full"
              disabled={busy}
              onClick={createDefault}
            >
              {create.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {create.isPending ? "Creating…" : "Create Link"}
            </Button>
          ) : null}

          {create.isError ? (
            <InlineError>Couldn’t create the link. Try again.</InlineError>
          ) : null}
          {update.isError ? (
            <InlineError>Couldn’t save the link. Try again.</InlineError>
          ) : null}
          {turnOn.isError ? (
            <InlineError>Couldn’t turn on live data. Try again.</InlineError>
          ) : null}

          {links && (liveShown || commentsShown || moreShown) ? (
            <div className="grid gap-1.5">
              {liveShown && defaultLink ? (
                <Disclosure
                  variant="row"
                  title="Live data"
                  status={liveStatus(defaultLink.grant ?? null, checked)}
                  open={liveOpen}
                  onOpenChange={openLive}
                >
                  <LiveDataPanel
                    grant={defaultLink.grant ?? null}
                    access={checked}
                    checking={check.isPending || turnOn.isPending}
                    checkFailed={check.isError}
                    canTurnOn={liveAllowed}
                    busy={busy}
                    url={defaultLink.url}
                    onRetry={() =>
                      check.mutate({
                        link: defaultLink,
                        session: session.current,
                      })
                    }
                    onTurnOn={() =>
                      turnOn.mutate({
                        link: defaultLink,
                        session: session.current,
                      })
                    }
                    onTurnOff={() => {
                      setAccess(null)
                      update.mutate({
                        link: defaultLink,
                        change: { grant: null },
                        said: "Live data off",
                      })
                    }}
                    onSaveGrant={(grant: LinkGrant) =>
                      update.mutateAsync({
                        link: defaultLink,
                        change: { grant },
                        said: "Fields saved",
                      })
                    }
                  />
                </Disclosure>
              ) : null}

              {commentsShown && defaultLink ? (
                <Disclosure
                  variant="row"
                  title="Comments"
                  status={commentsStatus(defaultLink)}
                >
                  <CommentsSwitch
                    link={defaultLink}
                    disabled={busy}
                    onChange={(allow) =>
                      update.mutate({
                        link: defaultLink,
                        said: allow ? "Comments on" : "Comments off",
                        change: allow
                          ? {
                              ...(defaultLink.level !== "comment"
                                ? { level: "comment" }
                                : {}),
                              comments: { acceptComments: true },
                            }
                          : { comments: { acceptComments: false } },
                      })
                    }
                  />
                </Disclosure>
              ) : null}

              {moreShown ? (
                <Disclosure
                  variant="row"
                  title="More links"
                  status={otherCount > 0 ? otherCount : undefined}
                  open={moreOpen}
                  onOpenChange={setMoreOpen}
                >
                  <div className="space-y-2">
                    <OtherLinkList
                      links={others}
                      editingId={editingLink?.id ?? null}
                      form={editingLink ? form("edit") : null}
                      menu={menu}
                    />
                    {editing?.kind === "new" ? (
                      form("new")
                    ) : canCreate ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => startEditing({ kind: "new" })}
                      >
                        <Plus className="size-4" />
                        New Link
                      </Button>
                    ) : null}
                  </div>
                </Disclosure>
              ) : null}
            </div>
          ) : null}

          {target.kind === "html" && list.data && !liveAllowed ? (
            <HtmlSafetyNote />
          ) : null}

          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter className="min-h-14 sm:min-h-14">
          {list.isError ? (
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
                {list.isFetching ? "Checking…" : "Try Again"}
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
  )
}

/** "Off", "42 Opportunities" for one collection, "57 records" for several. */
function liveStatus(
  grant: LinkGrant | null,
  access: ShareLinkAccess | null
): string {
  if (!grant) return "Off"
  const ids = Object.keys(grant.collections)
  if (!access || ids.length === 0) return "On"
  const counts = ids.map((id) =>
    Object.hasOwn(access.counts, id) ? access.counts[id] : undefined
  )
  if (ids.length === 1) {
    const id = ids[0]!
    const name =
      (Object.hasOwn(access.collections, id) && access.collections[id]?.name) ||
      id
    return counts[0] === undefined
      ? name
      : `${counts[0].toLocaleString("en-US")} ${name}`
  }
  if (counts.some((count) => count === undefined)) return "On"
  const total = counts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
  return `${total.toLocaleString("en-US")} records`
}

function commentsOn(link: ShareLink): boolean {
  return (
    link.level === "comment" &&
    link.comments.acceptComments &&
    !link.comments.autoPaused
  )
}

function commentsStatus(link: ShareLink): string {
  if (link.level === "comment" && link.comments.autoPaused) return "Paused"
  return commentsOn(link) ? "On" : "Off"
}

/** One switch for the default link: its comment level and whether it takes comments. */
function CommentsSwitch({
  link,
  disabled,
  onChange,
}: {
  link: ShareLink
  disabled: boolean
  onChange: (allow: boolean) => void
}) {
  const id = useId()
  return (
    <SettingRow label="Allow comments" htmlFor={id}>
      <Switch
        id={id}
        checked={commentsOn(link)}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </SettingRow>
  )
}

function DetailLine({
  parts,
  className,
}: {
  parts: ShareLinkDetail[]
  className?: string
}) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      {parts.map((part, index) => (
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
    </p>
  )
}

/** The default link: its URL to copy, when it expires, and its menu. */
export function DefaultLink({
  link,
  menu,
  onCopied,
}: {
  link: ShareLink
  menu: React.ReactNode
  onCopied: () => void
}) {
  const { copied, copy } = useCopy(onCopied)
  return (
    <div className="space-y-1.5">
      {link.url ? (
        <div className="flex gap-2">
          <Input
            readOnly
            aria-label="Link"
            value={link.url}
            className="min-w-0 flex-1 font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button type="button" onClick={() => void copy(link.url!)}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-7 items-center gap-2">
        <DetailLine
          parts={shareLinkSummary(link, { opened: false })}
          className="min-w-0 flex-1"
        />
        {menu}
      </div>
      {!link.url ? (
        <p className="text-sm text-muted-foreground">
          Make a new link to copy it again.
        </p>
      ) : null}
    </div>
  )
}

function DefaultLinkSkeleton() {
  return (
    <div className="space-y-1.5" role="status" aria-label="Loading links">
      <Skeleton className="h-10 w-full rounded-lg" />
      <Skeleton className="h-3 w-28" />
    </div>
  )
}

/** Links other than the default, each with its label, state and menu. */
export function OtherLinkList({
  links,
  editingId,
  form,
  menu,
}: {
  links: readonly ShareLink[]
  /** The link whose row shows `form` instead. */
  editingId: string | null
  form: React.ReactNode
  menu: (link: ShareLink, label: string) => React.ReactNode
}) {
  if (links.length === 0) return null
  return (
    <ul aria-label="Other links" className="space-y-1">
      {links.map((link) => {
        if (link.id === editingId)
          return (
            <li key={link.id} className="py-1.5">
              {form}
            </li>
          )
        const name = linkName(link)
        return (
          <li key={link.id} className="flex items-center gap-2 py-1.5">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p
                className={cn(
                  "truncate font-medium",
                  link.status === "revoked" && "text-muted-foreground"
                )}
              >
                {name}
              </p>
              <DetailLine parts={shareLinkSummary(link)} />
            </div>
            {link.canManage && link.status !== "revoked"
              ? menu(link, `Actions for ${name}`)
              : null}
          </li>
        )
      })}
    </ul>
  )
}

function LinkMenu({
  link,
  label,
  container,
  disabled,
  onEdit,
  onRevoke,
}: {
  link: ShareLink
  label: string
  container: HTMLElement | null
  disabled: boolean
  onEdit: () => void
  onRevoke: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            aria-label={label}
          />
        }
      >
        <MoreVertical className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={container}
        align="end"
        className="min-w-40"
      >
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="mr-2 size-4" />
          Edit Link
        </DropdownMenuItem>
        {link.url ? (
          <DropdownMenuItem onClick={() => copyShareLink(link.url!)}>
            <Copy className="mr-2 size-4" />
            Copy Link
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onRevoke}>
          <Unlink className="mr-2 size-4" />
          Revoke Link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A compact form for a link's label, expiry and password. */
function LinkForm({
  draft,
  onChange,
  choices,
  withLabel,
  passwords,
  passwordRequired,
  hasPassword,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
  container,
}: {
  draft: LinkDraft
  onChange: (draft: LinkDraft) => void
  choices: Array<{ value: ShareLinkExpiry; label: string }>
  withLabel: boolean
  passwords: boolean
  passwordRequired: boolean
  hasPassword: boolean
  busy: boolean
  submitLabel: string
  onSubmit: () => void
  onCancel: () => void
  container: HTMLElement | null
}) {
  const id = useId()
  const passwordOn = draft.passwordEnabled || passwordRequired
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {withLabel ? (
        <div className="space-y-2">
          <label htmlFor={`${id}-label`} className="text-sm font-medium">
            Label
          </label>
          <Input
            id={`${id}-label`}
            placeholder="Who is it for?"
            maxLength={SHARE_LINK_LABEL_MAX_LENGTH}
            required
            value={draft.label}
            disabled={busy}
            onChange={(event) =>
              onChange({ ...draft, label: event.target.value })
            }
          />
        </div>
      ) : null}
      <div className="space-y-2">
        <span id={`${id}-expires`} className="block text-sm font-medium">
          Expires
        </span>
        <Select
          value={draft.expiry}
          disabled={busy}
          onValueChange={(expiry) => {
            if (expiry) onChange({ ...draft, expiry })
          }}
        >
          <SelectTrigger
            aria-labelledby={`${id}-expires`}
            className="h-10 w-full"
          >
            <SelectValue>
              {choices.find((choice) => choice.value === draft.expiry)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent container={container}>
            {choices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {passwords ? (
        <div className="space-y-2">
          <SettingRow label="Password" htmlFor={`${id}-password-enabled`}>
            <Switch
              id={`${id}-password-enabled`}
              checked={passwordOn}
              disabled={busy || passwordRequired}
              onCheckedChange={(passwordEnabled) =>
                onChange({ ...draft, passwordEnabled, password: "" })
              }
            />
          </SettingRow>
          {passwordOn ? (
            <>
              <label htmlFor={`${id}-password`} className="sr-only">
                {hasPassword ? "New password" : "Link password"}
              </label>
              <Input
                id={`${id}-password`}
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required={!hasPassword}
                disabled={busy}
                placeholder={
                  hasPassword
                    ? "Leave blank to keep the password"
                    : "At least 8 characters"
                }
                value={draft.password}
                onChange={(event) =>
                  onChange({ ...draft, password: event.target.value })
                }
              />
              {hasPassword && draft.password ? (
                <p className="text-xs text-muted-foreground">
                  Changing it asks visitors to unlock the link again.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={busy || (withLabel && !draft.label.trim())}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {submitLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
