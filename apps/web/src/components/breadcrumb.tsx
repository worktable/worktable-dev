import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { ChevronRight, Clock3, Folder } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { DocumentNodeIcon } from "@/components/document-node-icon"
import { usePageMeta } from "@/hooks/use-page-meta"
import { useBreadcrumbs } from "@/hooks/use-breadcrumbs"
import type {
  Breadcrumb as BreadcrumbItem,
  BreadcrumbTarget,
} from "@/lib/breadcrumbs"
import { documentPathIsAtOrBelow } from "@/lib/document-views"
import type { TreeNode } from "@/lib/tree"

/** Marks the open document and the folders leading to it in folder menus. */
const currentEntryClass = "font-medium text-primary-text"

const crumbActionClass =
  "min-w-0 truncate rounded-sm transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"

export function Breadcrumb() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { pageMeta } = usePageMeta()
  const crumbs = useBreadcrumbs()
  if (crumbs.length === 0) return null

  const updatedAtLabel = pageMeta?.updatedAtLabel
  const provenanceLabel = pageMeta?.provenanceLabel

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 overflow-hidden text-xs text-muted-foreground"
    >
      {crumbs.map((crumb, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />
          )}
          {i === crumbs.length - 1 ? (
            updatedAtLabel && provenanceLabel ? (
              <PageDetailsCrumb
                // A new page starts with its details closed.
                key={pathname}
                label={crumb.label}
                updatedAtLabel={updatedAtLabel}
                provenanceLabel={provenanceLabel}
              />
            ) : (
              <span
                aria-current="page"
                className="truncate font-medium text-foreground"
              >
                {crumb.label}
              </span>
            )
          ) : (
            <AncestorCrumb crumb={crumb} />
          )}
        </span>
      ))}
    </nav>
  )
}

function AncestorCrumb({ crumb }: { crumb: BreadcrumbItem }) {
  if (crumb.kind === "link") {
    return (
      <CrumbLink target={crumb.target} className={crumbActionClass}>
        {crumb.label}
      </CrumbLink>
    )
  }
  if (crumb.kind === "folder") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<button type="button" />}
          className={`${crumbActionClass} data-popup-open:text-foreground`}
        >
          {crumb.label}
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-auto max-w-72 min-w-44">
          <FolderMenuEntries
            spaceId={crumb.spaceId}
            folder={crumb.node}
            currentPath={crumb.currentPath}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  return <span className="truncate">{crumb.label}</span>
}

/** A link to the page a crumb names. */
export function CrumbLink({
  target,
  className,
  style,
  onClick,
  children,
}: {
  target: BreadcrumbTarget
  className: string
  style?: CSSProperties
  onClick?: () => void
  children: ReactNode
}) {
  const props = { className, style, onClick, children }
  switch (target.to) {
    case "/spaces/$spaceId":
      return <Link to={target.to} params={target.params} {...props} />
    case "/spaces/$spaceId/records/$":
    case "/spaces/$spaceId/threads/$":
      return <Link to={target.to} params={target.params} {...props} />
    case "/threads/$":
      // Keep the list's location filter when returning from a thread.
      return (
        <Link
          to={target.to}
          params={target.params}
          search={(prev) => ({
            location: prev.location ?? "all",
            spaceId: prev.spaceId,
          })}
          {...props}
        />
      )
  }
}

function FolderMenuEntries({
  spaceId,
  folder,
  currentPath,
}: {
  spaceId: string
  folder: TreeNode
  currentPath: string
}) {
  const ownDocument = folder.kind !== "folder"
  const entries = folder.children.filter(
    (child) => child.kind !== "folder" || child.children.length > 0
  )
  return (
    <>
      {ownDocument && (
        <FolderMenuDocument
          spaceId={spaceId}
          node={folder}
          currentPath={currentPath}
        />
      )}
      {ownDocument && entries.length > 0 && <DropdownMenuSeparator />}
      {entries.map((child) =>
        child.isFolder && child.children.length > 0 ? (
          <DropdownMenuSub key={child.path}>
            <DropdownMenuSubTrigger
              className={
                documentPathIsAtOrBelow(currentPath, child.path)
                  ? currentEntryClass
                  : undefined
              }
            >
              <Folder className="text-primary/60" />
              <span className="truncate">{child.label}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-72 min-w-44">
              <FolderMenuEntries
                spaceId={spaceId}
                folder={child}
                currentPath={currentPath}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <FolderMenuDocument
            key={child.path}
            spaceId={spaceId}
            node={child}
            currentPath={currentPath}
          />
        )
      )}
    </>
  )
}

function FolderMenuDocument({
  spaceId,
  node,
  currentPath,
}: {
  spaceId: string
  node: TreeNode
  currentPath: string
}) {
  return (
    <DropdownMenuItem
      className={node.path === currentPath ? currentEntryClass : undefined}
      render={
        <Link
          to="/spaces/$spaceId/documents/$"
          params={{ spaceId, _splat: node.path }}
          aria-current={node.path === currentPath ? "page" : undefined}
        />
      }
    >
      <DocumentNodeIcon
        node={node}
        className={node.isFolder ? "text-primary/60" : "text-muted-foreground"}
      />
      <span className="truncate">{node.label}</span>
    </DropdownMenuItem>
  )
}

function PageDetailsCrumb({
  label,
  updatedAtLabel,
  provenanceLabel,
}: {
  label: string
  updatedAtLabel: string
  provenanceLabel: string
}) {
  const [metaOpen, setMetaOpen] = useState(false)
  const [metaMounted, setMetaMounted] = useState(false)
  const [metaPosition, setMetaPosition] = useState<CSSProperties>({})
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPointerTypeRef = useRef<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (unmountTimerRef.current) {
      clearTimeout(unmountTimerRef.current)
      unmountTimerRef.current = null
    }
  }, [])

  const updateMetaPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setMetaPosition({
      position: "fixed",
      top: rect.bottom + 8,
      right: Math.max(16, window.innerWidth - rect.right),
      zIndex: 50,
    })
  }, [])

  const openMeta = useCallback(() => {
    clearCloseTimer()
    updateMetaPosition()
    setMetaMounted(true)
    requestAnimationFrame(() => setMetaOpen(true))
  }, [clearCloseTimer, updateMetaPosition])

  const closeMeta = useCallback(() => {
    clearCloseTimer()
    setMetaOpen(false)
    unmountTimerRef.current = setTimeout(() => {
      setMetaMounted(false)
      unmountTimerRef.current = null
    }, 160)
  }, [clearCloseTimer])

  const closeMetaSoon = useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      closeMeta()
    }, 120)
  }, [clearCloseTimer, closeMeta])

  useEffect(() => {
    return clearCloseTimer
  }, [clearCloseTimer])

  useEffect(() => {
    if (!metaOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (
        triggerRef.current?.contains(target) ||
        contentRef.current?.contains(target)
      )
        return
      closeMeta()
    }
    const handleViewportChange = () => {
      if (lastPointerTypeRef.current === "mouse") {
        updateMetaPosition()
        return
      }
      closeMeta()
    }

    window.addEventListener("click", handlePointerDown)
    window.addEventListener("resize", handleViewportChange)
    window.addEventListener("scroll", handleViewportChange, true)
    return () => {
      window.removeEventListener("click", handlePointerDown)
      window.removeEventListener("resize", handleViewportChange)
      window.removeEventListener("scroll", handleViewportChange, true)
    }
  }, [metaOpen, updateMetaPosition, closeMeta])

  return (
    <span className="relative inline-flex max-w-full min-w-0 items-center gap-2">
      <span
        aria-current="page"
        className="inline-flex min-w-0 items-center truncate font-medium text-foreground"
      >
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        onPointerDown={(event) => {
          lastPointerTypeRef.current = event.pointerType
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") openMeta()
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") closeMetaSoon()
        }}
        onClick={() => {
          if (lastPointerTypeRef.current === "mouse") return
          if (metaOpen) {
            closeMeta()
            return
          }
          openMeta()
        }}
        aria-expanded={metaOpen}
        aria-label={`View details for ${label}`}
        title="View details"
      >
        <Clock3 className="size-3.5" />
      </button>
      {metaMounted && (
        <div
          ref={contentRef}
          style={metaPosition}
          className={`overlay-floating w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-xl bg-popover p-3 text-xs text-popover-foreground transition-all duration-150 ease-out outline-none ${
            metaOpen
              ? "translate-y-0 scale-100 opacity-100"
              : "pointer-events-none -translate-y-1 scale-95 opacity-0"
          }`}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") clearCloseTimer()
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") closeMetaSoon()
          }}
        >
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Clock3 className="size-3.5" />
            </div>
            <div className="min-w-0 space-y-0.5">
              <div className="leading-5 font-medium text-popover-foreground">
                {updatedAtLabel}
              </div>
              <div className="truncate leading-5 text-muted-foreground">
                {provenanceLabel}
              </div>
            </div>
          </div>
        </div>
      )}
    </span>
  )
}
