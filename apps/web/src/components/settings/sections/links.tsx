import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { useRef, useState } from "react"
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query"
import { Link2, Loader2, MoreVertical, Unlink } from "lucide-react"
import type {
  DocumentShareLinks,
  ShareLink,
  ShareLinksPage,
  SharingPolicy,
  SharingPolicyResponse,
} from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@worktable/ui/components/empty"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { SettingRow } from "@worktable/ui/components/setting-row"
import { Skeleton } from "@worktable/ui/components/skeleton"
import { toast } from "@worktable/ui/components/sonner"
import { Switch } from "@worktable/ui/components/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@worktable/ui/components/table"
import { cn } from "@worktable/ui/lib/utils"
import { SpaceIcon } from "@/components/identity-icons"
import { invalidateSharingQueries, notePageLinks } from "@/lib/sharing-cache"
import { documentQueryKeys } from "@/lib/documents-queries"
import { HttpError } from "@/lib/http"
import { useSpaces, useWorkspace } from "@/lib/queries"
import { revokeShareLink, shareLinksQueryKey } from "@/lib/share-link-management-api"
import {
  allShareLinksQueryKey,
  getShareLinksPage,
  getSharingPolicy,
  saveSharingPolicy,
  SHARE_POLICY_QUERY_KEY,
  type ShareLinksFilters,
} from "@/lib/share-links-settings-api"
import {
  SHARE_LINK_LEVEL_LABELS,
  shareLinkBlockedLabel,
  shareLinkDetails,
  shareLinkExpiry,
  shareLinkLastOpened,
} from "@/lib/share-links"
import { getSpaceArchiveInfo } from "@/lib/spaces"
import { SettingsGroup } from "../settings-group"
import { useSettingsSectionActive } from "../settings-dialog"

// Settings → Links: every share link the reader may oversee, and for owners
// the policy that applies to all of them. Both are read when the section is
// shown, never on a timer; a change updates the cache it touched.

export function LinksSection() {
  const active = useSettingsSectionActive()
  const workspace = useWorkspace().data
  const owner = workspace?.person?.role === "owner"
  return (
    <div className="flex flex-col gap-6">
      {owner ? (
        <PolicyGroup enabled={active} teams={Boolean(workspace?.teamContext)} />
      ) : null}
      <LinkList enabled={active} titled={owner} />
    </div>
  )
}

// ── Policy ───────────────────────────────────────────────────────────────────

const WHO_MAY_SHARE: Array<{
  value: SharingPolicy["whoMayShare"]
  label: string
}> = [
  { value: "owners", label: "Owners only" },
  { value: "space-managers", label: "Space managers" },
  { value: "editors", label: "Anyone who can edit" },
]

const LONGEST_EXPIRY = [
  { value: "none", label: "No limit", days: null },
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "1 year", days: 365 },
] as const

function expiryLabel(days: number | null): string {
  if (days === null) return "No limit"
  return (
    LONGEST_EXPIRY.find((choice) => choice.days === days)?.label ??
    (days === 1 ? "1 day" : `${days} days`)
  )
}

/**
 * The owner policy, and a way to change it. Each change is sent as the last
 * policy the server confirmed plus that change, one save at a time in
 * order, with the revision it was made from. A save made from an older copy,
 * such as one from another window, is refused, and the newer policy shows.
 */
function useSharingPolicy(enabled: boolean) {
  const queryClient = useQueryClient()
  // The server's copy, which every save builds on; the query's own data
  // also shows changes still on their way.
  const confirmed = useRef<SharingPolicyResponse | null>(
    queryClient.getQueryData<SharingPolicyResponse>(SHARE_POLICY_QUERY_KEY) ??
      null
  )
  const query = useQuery({
    queryKey: SHARE_POLICY_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const policy = await getSharingPolicy(signal)
      if (!signal.aborted) confirmed.current = policy
      return policy
    },
    enabled,
  })
  const save = useMutation({
    mutationKey: SHARE_POLICY_QUERY_KEY,
    scope: { id: "share-policy" },
    mutationFn: (change: Partial<SharingPolicy>) => {
      const base = confirmed.current!
      return saveSharingPolicy({ ...base.policy, ...change }, base.revision)
    },
    // The control answers at once; the server's copy replaces it.
    onMutate: async (change) => {
      await queryClient.cancelQueries({
        queryKey: SHARE_POLICY_QUERY_KEY,
        exact: true,
      })
      queryClient.setQueryData<SharingPolicyResponse>(
        SHARE_POLICY_QUERY_KEY,
        (current) =>
          current && { ...current, policy: { ...current.policy, ...change } }
      )
    },
    onSuccess: (saved) => {
      confirmed.current = saved
    },
    onError: (error) => {
      const newer =
        error instanceof HttpError && error.status === 409
          ? (error.body as SharingPolicyResponse)
          : null
      if (newer?.policy) confirmed.current = newer
      toast.error(
        newer?.policy
          ? "The policy changed elsewhere. Check it and try again."
          : "Couldn’t save the change. Try again."
      )
    },
    onSettled: async (saved, error) => {
      const state = queryClient.getQueryState<SharingPolicyResponse>(
        SHARE_POLICY_QUERY_KEY
      )
      // A socket or focus read can already carry another owner's newer save.
      // If cancelling that read, replace it after installing our response.
      const revalidate =
        state?.fetchStatus === "fetching" ||
        state?.isInvalidated === true ||
        (state?.data?.revision ?? 0) >
          (saved?.revision ?? confirmed.current?.revision ?? 0)
      await queryClient.cancelQueries({
        queryKey: SHARE_POLICY_QUERY_KEY,
        exact: true,
      })
      const newer =
        error instanceof HttpError && error.status === 409
          ? (error.body as SharingPolicyResponse)
          : null
      if (saved) confirmed.current = saved
      else if (newer?.policy) confirmed.current = newer
      // A later change still on its way brings the newer copy.
      if (queryClient.isMutating({ mutationKey: SHARE_POLICY_QUERY_KEY }) > 1)
        return
      if (confirmed.current) {
        queryClient.setQueryData(SHARE_POLICY_QUERY_KEY, confirmed.current)
      }
      // Whether each link opens follows the policy: the lists, and each
      // document page's count of links that open and whether Share makes
      // one. Only the page on screen reads again now.
      const authoritative = Boolean(saved || newer?.policy)
      invalidateSharingQueries(
        queryClient,
        authoritative ? confirmed.current?.revision : undefined,
        { keepPolicy: authoritative }
      )
      if (authoritative && revalidate)
        void queryClient.invalidateQueries({
          queryKey: SHARE_POLICY_QUERY_KEY,
          exact: true,
        })
    },
  })
  const update = (change: Partial<SharingPolicy>) => {
    if (confirmed.current) save.mutate(change)
  }
  return { query, update }
}

function PolicyGroup({ enabled, teams }: { enabled: boolean; teams: boolean }) {
  const preview = useDeploymentInfo().data?.capabilities.sharingPreview === true
  const { query, update } = useSharingPolicy(enabled)
  const policy = query.data?.policy

  return (
    <SettingsGroup title="Policy">
      {query.isError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 py-1">
          <p className="text-sm text-muted-foreground">
            Couldn’t load the policy.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            Try again
          </Button>
        </div>
      ) : !policy ? (
        <div className="flex flex-col gap-4 py-1" role="status">
          <span className="sr-only">Loading the policy</span>
          {Array.from({ length: teams ? 4 : 3 }, (_, index) => (
            <div key={index} className="flex items-center justify-between">
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-8 w-40" />
            </div>
          ))}
        </div>
      ) : (
        <>
          <SettingRow
            label="Pause all links"
            description={
              policy.paused
                ? "No link opens until you turn this off."
                : "Stops every link at once."
            }
          >
            <Switch
              checked={policy.paused}
              onCheckedChange={(paused) => update({ paused })}
            />
          </SettingRow>
          {teams ? (
            <SettingRow
              className="flex-col items-start sm:flex-row sm:items-center"
              label="Who can share"
              description="Links stop when their creator can no longer share."
            >
              <Select
                value={policy.whoMayShare}
                onValueChange={(whoMayShare) => {
                  if (whoMayShare) update({ whoMayShare })
                }}
              >
                <SelectTrigger className="w-48">
                  <SelectValue>
                    {
                      WHO_MAY_SHARE.find(
                        (choice) => choice.value === policy.whoMayShare
                      )?.label
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {WHO_MAY_SHARE.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          ) : null}
          <SpacesSetting policy={policy} onChange={update} />
          {preview ? (
            <SettingRow
              label="Require a password"
              description="Links without a password stop opening while this is on."
            >
              <Switch
                checked={policy.requirePassword}
                onCheckedChange={(requirePassword) =>
                  update({ requirePassword })
                }
              />
            </SettingRow>
          ) : null}
          <SettingRow
            className="flex-col items-start sm:flex-row sm:items-center"
            label="Longest expiry"
            description="Links stop opening this long after they’re made."
          >
            <Select
              value={
                policy.maxExpiryDays === null
                  ? "none"
                  : String(policy.maxExpiryDays)
              }
              onValueChange={(value) => {
                const choice = LONGEST_EXPIRY.find(
                  (option) => option.value === value
                )
                if (choice) update({ maxExpiryDays: choice.days })
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue>{expiryLabel(policy.maxExpiryDays)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {LONGEST_EXPIRY.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        </>
      )}
    </SettingsGroup>
  )
}

/**
 * Where links can be made and opened. Choosing some Spaces starts from all
 * of them, so nothing stops until the owner leaves one out.
 */
function SpacesSetting({
  policy,
  onChange,
}: {
  policy: SharingPolicy
  onChange: (change: Partial<SharingPolicy>) => void
}) {
  const loaded = useSpaces().data
  const spaces = (loaded ?? []).filter((space) => !getSpaceArchiveInfo(space))
  const selected = policy.spaces.mode === "selected" ? policy.spaces : null
  const chosen = new Set(selected?.spaceIds ?? [])

  function toggle(spaceId: string, on: boolean) {
    const next = new Set(chosen)
    if (on) next.add(spaceId)
    else next.delete(spaceId)
    onChange({ spaces: { mode: "selected", spaceIds: [...next] } })
  }

  return (
    <div className="flex flex-col gap-3">
      <SettingRow
        className="flex-col items-start sm:flex-row sm:items-center"
        label="Spaces"
        description="Where links can be made and opened."
      >
        <Select
          value={policy.spaces.mode}
          onValueChange={(mode) => {
            if (mode === "all") onChange({ spaces: { mode: "all" } })
            else if (mode === "selected" && !selected && loaded) {
              onChange({
                spaces: {
                  mode: "selected",
                  spaceIds: spaces.map((space) => space.id),
                },
              })
            }
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue>
              {selected ? "Selected Spaces" : "All Spaces"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Spaces</SelectItem>
            {/* Starts from every Space, so it waits until they are known. */}
            <SelectItem value="selected" disabled={!loaded}>
              Selected Spaces
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      {selected ? (
        <fieldset className="flex flex-col gap-1 rounded-lg bg-surface-inset p-2">
          <legend className="sr-only">Spaces where links work</legend>
          {spaces.map((space) => (
            <label
              key={space.id}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-hover"
            >
              <Checkbox
                checked={chosen.has(space.id)}
                onCheckedChange={(on) => toggle(space.id, on === true)}
              />
              <SpaceIcon space={space} size="xs" />
              <span className="min-w-0 truncate text-sm text-foreground">
                {space.name}
              </span>
            </label>
          ))}
          {chosen.size === 0 ? (
            <p className="px-2 py-1 text-xs text-destructive">
              With no Space selected, no link opens.
            </p>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  )
}

// ── Links ────────────────────────────────────────────────────────────────────

const STATUS_CHOICES = [
  { value: "all", label: "All links" },
  { value: "expired", label: "Expired" },
  { value: "revoked", label: "Revoked" },
] as const

type StatusChoice = (typeof STATUS_CHOICES)[number]["value"]

function filtersFor(spaceId: string, status: StatusChoice): ShareLinksFilters {
  return {
    ...(spaceId !== "all" ? { spaceId } : {}),
    ...(status !== "all" ? { status } : {}),
  }
}

/**
 * Take a revoked link out of the list on screen, which shows revoked links
 * only when filtered to them, and out of its document's cached state.
 */
function noteRevoked(
  queryClient: QueryClient,
  filters: ShareLinksFilters,
  revoked: ShareLink,
  before: ShareLink
): void {
  queryClient.setQueryData<InfiniteData<ShareLinksPage>>(
    allShareLinksQueryKey(filters),
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          links: page.links.flatMap((link) =>
            link.id !== revoked.id
              ? [link]
              : filters.status === "revoked"
                ? [revoked]
                : []
          ),
        })),
      }
  )
  // Other filters read again when next shown.
  void queryClient.invalidateQueries({
    queryKey: ["share-links", "all"],
    refetchType: "none",
  })
  if (!before.path) return
  queryClient.setQueryData<DocumentShareLinks>(
    shareLinksQueryKey(before.spaceId, before.path),
    (current) =>
      current && {
        ...current,
        links: current.links.filter((link) => link.id !== revoked.id),
      }
  )
  const remaining = queryClient.getQueryData<DocumentShareLinks>(
    shareLinksQueryKey(before.spaceId, before.path)
  )
  if (remaining)
    notePageLinks(queryClient, before.spaceId, before.path, remaining.links)
  else
    void queryClient.invalidateQueries({
      queryKey: documentQueryKeys.page(before.spaceId, before.path),
      exact: true,
    })
}

function LinkList({ enabled, titled }: { enabled: boolean; titled: boolean }) {
  const queryClient = useQueryClient()
  const [spaceId, setSpaceId] = useState("all")
  const [status, setStatus] = useState<StatusChoice>("all")
  const [revoking, setRevoking] = useState<ShareLink | null>(null)
  const filters = filtersFor(spaceId, status)
  const pages = useInfiniteQuery({
    queryKey: allShareLinksQueryKey(filters),
    queryFn: ({ pageParam }) => getShareLinksPage(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
  })
  const spacesById = new Map(
    (useSpaces().data ?? []).map((space) => [space.id, space])
  )
  const filterSpaces = pages.data?.pages[0]?.spaces ?? []
  const links = pages.data?.pages.flatMap((page) => page.links)
  const filtered = spaceId !== "all" || status !== "all"

  const revoke = useMutation({
    mutationFn: (link: ShareLink) => revokeShareLink(link.id),
    onSuccess: ({ link }, before) => {
      noteRevoked(queryClient, filters, link, before)
      setRevoking(null)
    },
  })

  const spaceName = (id: string) =>
    spacesById.get(id)?.name ??
    filterSpaces.find((space) => space.id === id)?.name ??
    "Unknown Space"

  return (
    <section className="flex flex-col gap-3" aria-label="Share links">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {titled ? (
          <h3 className="text-sm font-medium text-foreground">Share links</h3>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={spaceId}
            onValueChange={(value) => {
              if (value) setSpaceId(value)
            }}
          >
            <SelectTrigger className="w-44" aria-label="Space">
              <SelectValue>
                {spaceId === "all" ? "All Spaces" : spaceName(spaceId)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Spaces</SelectItem>
              {filterSpaces.map((space) => (
                <SelectItem key={space.id} value={space.id}>
                  {space.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(value) => {
              if (value) setStatus(value)
            }}
          >
            <SelectTrigger className="w-32" aria-label="Status">
              <SelectValue>
                {
                  STATUS_CHOICES.find((choice) => choice.value === status)
                    ?.label
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STATUS_CHOICES.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {pages.isError ? (
        <div className="flex flex-col items-center gap-3 rounded-xl card-surface px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">Couldn’t load links.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void pages.refetch()}
            disabled={pages.isFetching}
          >
            Try again
          </Button>
        </div>
      ) : !links ? (
        <LinkListSkeleton />
      ) : links.length === 0 ? (
        <Empty className="rounded-xl card-surface py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Link2 />
            </EmptyMedia>
            <EmptyTitle>
              {filtered ? "No links here" : "No links yet"}
            </EmptyTitle>
            <EmptyDescription>
              {filtered
                ? status === "revoked"
                  ? "Revoked links stay here for 90 days."
                  : "No links match these filters."
                : "Links made with Share on a document appear here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="hidden rounded-xl card-surface lg:block">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pr-2 pl-4">Document</TableHead>
                  <TableHead className="px-2">Label</TableHead>
                  <TableHead className="px-2">Access</TableHead>
                  <TableHead className="px-2">Expires</TableHead>
                  <TableHead className="px-2">Last opened</TableHead>
                  <TableHead className="px-2">Created by</TableHead>
                  <TableHead className="pr-2 pl-0">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.map((link) => (
                  <LinkRow
                    key={link.id}
                    link={link}
                    space={spacesById.get(link.spaceId)}
                    spaceName={spaceName(link.spaceId)}
                    onRevoke={() => {
                      revoke.reset()
                      setRevoking(link)
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
          <ul
            className="flex flex-col divide-y divide-border/60 rounded-xl card-surface lg:hidden"
            aria-label="Links"
          >
            {links.map((link) => (
              <LinkItem
                key={link.id}
                link={link}
                spaceName={spaceName(link.spaceId)}
                onRevoke={() => {
                  revoke.reset()
                  setRevoking(link)
                }}
              />
            ))}
          </ul>
          {pages.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void pages.fetchNextPage()}
                disabled={pages.isFetchingNextPage}
              >
                {pages.isFetchingNextPage ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                {pages.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : status === "revoked" ? (
            <p className="text-center text-xs text-muted-foreground">
              Revoked links stay here for 90 days.
            </p>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null)
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
          <p className="text-sm text-destructive" role="alert">
            Couldn’t revoke the link. Try again.
          </p>
        ) : null}
      </ConfirmDialog>
    </section>
  )
}

function documentName(link: ShareLink): string {
  return link.title ?? link.path?.split("/").at(-1) ?? "Removed document"
}

function LinkMenu({
  link,
  onRevoke,
}: {
  link: ShareLink
  onRevoke: () => void
}) {
  if (!link.canManage || link.status === "revoked") return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${link.label || "Untitled link"}`}
          />
        }
      >
        <MoreVertical className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem variant="destructive" onClick={onRevoke}>
          <Unlink className="mr-2 size-4" />
          Revoke Link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function LinkRow({
  link,
  space,
  spaceName,
  onRevoke,
}: {
  link: ShareLink
  space: Parameters<typeof SpaceIcon>[0]["space"] | undefined
  spaceName: string
  onRevoke: () => void
}) {
  const expiry = shareLinkExpiry(link)
  const revoked = link.status === "revoked"
  return (
    <TableRow className={cn(revoked && "text-muted-foreground")}>
      <TableCell className="pr-2 pl-4 align-middle">
        <span
          className={cn(
            "block max-w-52 truncate",
            revoked ? "text-muted-foreground" : "font-medium text-foreground"
          )}
          title={documentName(link)}
        >
          {documentName(link)}
        </span>
        <span className="mt-0.5 flex max-w-52 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {space ? <SpaceIcon space={space} size="xs" /> : null}
          <span className="truncate" title={spaceName}>
            {spaceName}
          </span>
        </span>
      </TableCell>
      <TableCell className="px-2 align-middle">
        <span
          className={cn(
            "block max-w-32 truncate",
            !link.label && "text-muted-foreground"
          )}
          title={link.label || undefined}
        >
          {link.label || "Untitled link"}
        </span>
      </TableCell>
      <TableCell className="px-2 align-middle">
        <span className="block whitespace-nowrap">
          {SHARE_LINK_LEVEL_LABELS[link.level]}
        </span>
        {link.status === "blocked" && link.blockedBy ? (
          <span className="block max-w-32 text-xs leading-4 text-destructive">
            {shareLinkBlockedLabel(link.blockedBy)}
          </span>
        ) : null}
      </TableCell>
      <TableCell
        className={cn(
          "px-2 align-middle whitespace-nowrap",
          expiry.stopped && "text-destructive"
        )}
      >
        {expiry.text}
      </TableCell>
      <TableCell
        className={cn(
          "px-2 align-middle whitespace-nowrap",
          !link.lastUsedAt && "text-muted-foreground"
        )}
      >
        {shareLinkLastOpened(link)}
      </TableCell>
      <TableCell className="px-2 align-middle">
        <span
          className={cn(
            "block max-w-28 truncate",
            !link.createdBy.name && "text-muted-foreground"
          )}
          title={link.createdBy.name || undefined}
        >
          {link.createdBy.name || "Not recorded"}
        </span>
      </TableCell>
      <TableCell className="pr-2 pl-0 text-right align-middle">
        <LinkMenu link={link} onRevoke={onRevoke} />
      </TableCell>
    </TableRow>
  )
}

/** A link as narrower screens list it. */
function LinkItem({
  link,
  spaceName,
  onRevoke,
}: {
  link: ShareLink
  spaceName: string
  onRevoke: () => void
}) {
  return (
    <li className="flex items-start gap-3 py-3 pr-2 pl-4">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p
          className={cn(
            "truncate text-sm",
            link.status === "revoked"
              ? "text-muted-foreground"
              : "font-medium text-foreground"
          )}
        >
          {documentName(link)}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {[spaceName, link.label || "Untitled link", link.createdBy.name]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="text-xs text-muted-foreground">
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
        </p>
      </div>
      <LinkMenu link={link} onRevoke={onRevoke} />
    </li>
  )
}

function LinkListSkeleton() {
  return (
    <div
      className="flex flex-col divide-y divide-border/60 rounded-xl card-surface"
      role="status"
      aria-label="Loading links"
    >
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
      ))}
    </div>
  )
}
