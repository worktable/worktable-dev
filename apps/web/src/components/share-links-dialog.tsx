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
  shareLinkExpiry,
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
  /** Only the first link is made with comments or live data. */
  comments: boolean
  live: boolean
}

/** `new` makes a labelled link under More links. */
type Editing = { kind: "new" } | { kind: "edit"; link: ShareLink } | null

function newDraft(policy: SharerPolicy | undefined): LinkDraft {
  return {
    label: "",
    expiry: defaultShareLinkExpiry(policy),
    passwordEnabled: false,
    password: "",
    comments: false,
    live: false,
  }
}

function linkName(link: ShareLink): string {
  return link.label || "Untitled link"
}

/**
 * The share dialog: the document's default link to copy, its settings, and
 * any other links. Before the default link exists, the same settings show
 * what it will be made with. Loaded when the page's Share is first opened;
 * it reads the document's links once per opening.
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
  // The first link's Password row; null until opened or closed by hand.
  const [passwordOpen, setPasswordOpen] = useState<boolean | null>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
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
  const passwordRequired = policy?.requirePassword ?? false
  const liveAllowed =
    preview && target.kind === "html" && policy?.liveLinks === true
  const liveShown =
    preview &&
    target.kind === "html" &&
    defaultLink !== null &&
    (policy?.liveLinks === true || defaultLink.grant !== undefined)
  const commentsAllowed = preview && policy?.levels.includes("comment") === true
  const commentsShown =
    defaultLink !== null &&
    (commentsAllowed || (preview && defaultLink.level === "comment"))
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
          ? {
              level: input.comments ? "comment" : "view",
              comments: DEFAULT_SHARE_LINK_COMMENT_SETTINGS,
            }
          : {}),
        expiresAt: shareLinkExpiresAt(input.expiry) ?? null,
        ...(input.passwordEnabled || passwordRequired
          ? { password: input.password }
          : {}),
      }),
    onSuccess: (result, input) => {
      const link = { ...result.link, url: result.link.url ?? result.url }
      writeLinks((current) => [
        link,
        ...current.filter((candidate) => candidate.id !== link.id),
      ])
      setEditing(null)
      setDraft(newDraft(policy))
      setAnnouncement("Link created")
      if (!input.live) return
      // Open, so what visitors will see shows as soon as it's checked.
      setLiveOpen(true)
      turnOn.mutate({ link, session: session.current })
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
      setDraft(newDraft(undefined))
      setLiveOpen(false)
      setMoreOpen(false)
      setPasswordOpen(null)
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
            comments: false,
            live: false,
          }
        : newDraft(policy)
    )
  }

  function createDefault() {
    if (busy) return
    // A closed row's field isn't in the form, so the browser can't check it.
    const passwordOn = draft.passwordEnabled || passwordRequired
    if (passwordOn && draft.password.length < 8) {
      setPasswordOpen(true)
      requestAnimationFrame(() => {
        passwordInput.current?.focus()
        passwordInput.current?.reportValidity()
      })
      return
    }
    create.mutate({
      ...draft,
      label: "",
      expiry: allowedShareLinkExpiry(draft.expiry, choices),
      comments: draft.comments && commentsAllowed,
      live: draft.live && liveAllowed,
    })
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
    if (editing.kind === "new") {
      create.mutate({ ...draft, expiry, comments: false, live: false })
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
        ...(!draft.passwordEnabled && !passwordRequired
          ? link.hasPassword
            ? { password: null }
            : {}
          : draft.password
            ? { password: draft.password }
            : {}),
      },
    })
  }

  function form(kind: "new" | "edit") {
    return (
      <LinkForm
        draft={{
          ...draft,
          expiry: allowedShareLinkExpiry(draft.expiry, choices),
        }}
        onChange={setDraft}
        choices={choices}
        withLabel={kind === "new" || Boolean(editingLink?.label)}
        passwordRequired={passwordRequired}
        hasPassword={editingLink?.hasPassword ?? false}
        busy={busy}
        submitLabel={kind === "new" ? "Create Link" : "Save"}
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
        onEdit={
          link === defaultLink
            ? undefined
            : () => startEditing({ kind: "edit", link })
        }
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
            {`Anyone with the link${
              (
                defaultLink
                  ? defaultLink.hasPassword
                  : draft.passwordEnabled || passwordRequired
              )
                ? " and its password"
                : ""
            } can ${target.kind === "html" ? "use this tool" : "view this document"}`}
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
          ) : defaultLink ? (
            <DefaultLink
              link={defaultLink}
              menu={menu(defaultLink, "Link actions")}
              onCopied={() => setAnnouncement("Link copied")}
            />
          ) : canCreate && editing === null ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                createDefault()
              }}
            >
              <div className="grid gap-1.5">
                <ExpiryRow
                  value={allowedShareLinkExpiry(draft.expiry, choices)}
                  choices={choices}
                  disabled={busy}
                  container={portalContainer}
                  onChange={(expiry) => setDraft({ ...draft, expiry })}
                />
                <Disclosure
                  variant="row"
                  title="Password"
                  status={
                    draft.passwordEnabled || passwordRequired ? "On" : "Off"
                  }
                  open={passwordOpen ?? passwordRequired}
                  onOpenChange={setPasswordOpen}
                >
                  <PasswordFields
                    enabled={draft.passwordEnabled || passwordRequired}
                    required={passwordRequired}
                    hasPassword={false}
                    inputRef={passwordInput}
                    value={draft.password}
                    disabled={busy}
                    onEnabledChange={(passwordEnabled) =>
                      setDraft({ ...draft, passwordEnabled, password: "" })
                    }
                    onValueChange={(password) =>
                      setDraft({ ...draft, password })
                    }
                  />
                </Disclosure>
                {commentsAllowed ? (
                  <Disclosure
                    variant="row"
                    title="Comments"
                    status={draft.comments ? "On" : "Off"}
                  >
                    <CommentsSwitch
                      checked={draft.comments}
                      disabled={busy}
                      onChange={(comments) => setDraft({ ...draft, comments })}
                    />
                  </Disclosure>
                ) : null}
                {liveAllowed ? (
                  <Disclosure
                    variant="row"
                    title="Live data"
                    status={draft.live ? "On" : "Off"}
                  >
                    <LiveSwitch
                      checked={draft.live}
                      disabled={busy}
                      onChange={(live) => setDraft({ ...draft, live })}
                    />
                  </Disclosure>
                ) : null}
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {create.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {create.isPending ? "Creating…" : "Create Link"}
              </Button>
            </form>
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

          {links && (defaultLink || moreShown) ? (
            <div className="grid gap-1.5">
              {defaultLink ? (
                <>
                  <ExpiryRow
                    status={shareLinkExpiry(defaultLink)}
                    value={defaultLink.expiresAt ? "keep" : "never"}
                    choices={shareLinkExpiryChoices(policy, defaultLink)}
                    disabled={busy}
                    container={portalContainer}
                    onChange={(expiry) => {
                      const expiresAt = shareLinkExpiresAt(expiry)
                      if (expiresAt !== undefined)
                        update.mutate({
                          link: defaultLink,
                          change: { expiresAt },
                          said: "Expiry saved",
                        })
                    }}
                  />
                  <Disclosure
                    variant="row"
                    title="Password"
                    status={defaultLink.hasPassword ? "On" : "Off"}
                  >
                    <LinkPassword
                      key={defaultLink.id}
                      link={defaultLink}
                      required={passwordRequired}
                      busy={busy}
                      onSave={(password) =>
                        update.mutateAsync({
                          link: defaultLink,
                          change: { password },
                          said: password
                            ? "Password saved"
                            : "Password removed",
                        })
                      }
                    />
                  </Disclosure>
                </>
              ) : null}

              {commentsShown && defaultLink ? (
                <Disclosure
                  variant="row"
                  title="Comments"
                  status={commentsStatus(defaultLink)}
                >
                  <CommentsSwitch
                    checked={commentsOn(defaultLink)}
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
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  onChange: (allow: boolean) => void
}) {
  const id = useId()
  return (
    <SettingRow label="Allow comments" htmlFor={id}>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </SettingRow>
  )
}

/** Live data for a link not made yet; fields can be hidden once it is. */
function LiveSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  onChange: (live: boolean) => void
}) {
  const id = useId()
  return (
    <SettingRow label="Show live data" htmlFor={id}>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </SettingRow>
  )
}

/** When a link stops opening, as a row whose status is the choice or date. */
function ExpiryRow({
  value,
  choices,
  status,
  disabled,
  container,
  onChange,
}: {
  value: ShareLinkExpiry
  choices: Array<{ value: ShareLinkExpiry; label: string }>
  /** The saved link's expiry; a new link shows its choice. */
  status?: ShareLinkDetail
  disabled: boolean
  container: HTMLElement | null
  onChange: (expiry: ShareLinkExpiry) => void
}) {
  const label = choices.find((choice) => choice.value === value)?.label
  return (
    <Disclosure
      variant="row"
      title="Expires"
      status={
        <span className={cn(status?.stopped && "text-destructive")}>
          {status?.text ?? label}
        </span>
      }
    >
      <ExpirySelect
        value={value}
        choices={choices}
        disabled={disabled}
        container={container}
        onChange={onChange}
        aria-label="Expires"
      />
    </Disclosure>
  )
}

function ExpirySelect({
  value,
  choices,
  disabled,
  container,
  onChange,
  ...labelled
}: {
  value: ShareLinkExpiry
  choices: Array<{ value: ShareLinkExpiry; label: string }>
  disabled: boolean
  container: HTMLElement | null
  onChange: (expiry: ShareLinkExpiry) => void
} & ({ "aria-label": string } | { "aria-labelledby": string })) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(expiry) => {
        if (expiry && expiry !== value) onChange(expiry)
      }}
    >
      <SelectTrigger {...labelled} className="h-10 w-full">
        <SelectValue>
          {choices.find((choice) => choice.value === value)?.label}
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
  )
}

/** A password switch and, while it's on, the field for a new password. */
function PasswordFields({
  enabled,
  required,
  hasPassword,
  value,
  disabled,
  onEnabledChange,
  onValueChange,
  inputRef,
}: {
  enabled: boolean
  /** The owner policy needs a password on every link. */
  required: boolean
  /** The link already has one; a blank field keeps it. */
  hasPassword: boolean
  value: string
  disabled: boolean
  onEnabledChange: (enabled: boolean) => void
  onValueChange: (value: string) => void
  inputRef?: React.Ref<HTMLInputElement>
}) {
  const id = useId()
  return (
    <div className="space-y-2">
      <SettingRow label="Ask for a password" htmlFor={`${id}-enabled`}>
        <Switch
          id={`${id}-enabled`}
          checked={enabled}
          disabled={disabled || required}
          onCheckedChange={onEnabledChange}
        />
      </SettingRow>
      {enabled ? (
        <>
          <label htmlFor={`${id}-password`} className="sr-only">
            {hasPassword ? "New password" : "Link password"}
          </label>
          <Input
            ref={inputRef}
            id={`${id}-password`}
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required={!hasPassword}
            disabled={disabled}
            placeholder={
              hasPassword
                ? "Leave blank to keep the password"
                : "At least 8 characters"
            }
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
          />
          {hasPassword && value ? (
            <p className="text-xs text-muted-foreground">
              Changing it asks visitors to unlock the link again.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/**
 * The default link's password. Turning it off saves at once; a new password
 * saves with its button.
 */
function LinkPassword({
  link,
  required,
  busy,
  onSave,
}: {
  link: ShareLink
  required: boolean
  busy: boolean
  onSave: (password: string | null) => Promise<unknown>
}) {
  const [enabled, setEnabled] = useState(link.hasPassword || required)
  const [value, setValue] = useState("")
  const on = enabled || required
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (value)
          void onSave(value).then(
            () => setValue(""),
            () => {}
          )
      }}
    >
      <PasswordFields
        enabled={on}
        required={required}
        hasPassword={link.hasPassword}
        value={value}
        disabled={busy}
        onEnabledChange={(next) => {
          setEnabled(next)
          setValue("")
          if (!next && link.hasPassword)
            void onSave(null).catch(() => setEnabled(true))
        }}
        onValueChange={setValue}
      />
      {on && value ? (
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Save
        </Button>
      ) : null}
    </form>
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

/**
 * The default link: its URL to copy and its menu, and why it doesn't open
 * when it doesn't. Its expiry and password are rows below it.
 */
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
  const stopped = shareLinkSummary(link, { opened: false }).filter(
    (part) => part.stopped
  )
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        {link.url ? (
          <>
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
          </>
        ) : (
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Make a new link to copy it again.
          </p>
        )}
        {menu}
      </div>
      {stopped.length > 0 ? <DetailLine parts={stopped} /> : null}
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
  /** Absent for the default link, whose settings show in the dialog. */
  onEdit?: () => void
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
        {onEdit ? (
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 size-4" />
            Edit Link
          </DropdownMenuItem>
        ) : null}
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
  passwordRequired: boolean
  hasPassword: boolean
  busy: boolean
  submitLabel: string
  onSubmit: () => void
  onCancel: () => void
  container: HTMLElement | null
}) {
  const id = useId()
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
        <ExpirySelect
          value={draft.expiry}
          choices={choices}
          disabled={busy}
          container={container}
          onChange={(expiry) => onChange({ ...draft, expiry })}
          aria-labelledby={`${id}-expires`}
        />
      </div>
      <PasswordFields
        enabled={draft.passwordEnabled || passwordRequired}
        required={passwordRequired}
        hasPassword={hasPassword}
        value={draft.password}
        disabled={busy}
        onEnabledChange={(passwordEnabled) =>
          onChange({ ...draft, passwordEnabled, password: "" })
        }
        onValueChange={(password) => onChange({ ...draft, password })}
      />
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
