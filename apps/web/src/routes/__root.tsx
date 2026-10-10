/// <reference types="vite/client" />
import {
  DocumentLifetimeChip,
  DocumentOrganizeMenuItems,
} from "@/components/document-organize"
import { WorkspaceOperationObserver } from "@/components/workspace-operation-observer"
import { WorkspaceStorageGate } from "@/components/workspace-storage-gate"
import appStylesheet from "@/styles/app.css?url"
import {
  DocumentOpening,
  DocumentOpeningData,
  documentOpeningLayoutScript,
  documentOpeningPreloadScript,
} from "@/components/document-opening"

import {
  Fragment,
  Suspense,
  lazy,
  memo,
  useState,
  useCallback,
  useEffect,
  useMemo,
} from "react"
import type { CSSProperties, ReactNode } from "react"
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useRouterState,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router"
import type { QueryClient } from "@tanstack/react-query"
import { QueryClientProvider } from "@tanstack/react-query"
import {
  PanelLeft,
  PanelRight,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Loader2,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { THEME_SHELL_COLORS } from "@worktable/ui/theme"
import { fontBootstrapScript } from "@worktable/ui/lib/fonts"
import { ResizeHandle } from "@worktable/ui/components/resize-handle"
import { useResizable } from "@worktable/ui/hooks/use-resizable"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@worktable/ui/components/dropdown-menu"
import { Toaster } from "@worktable/ui/components/sonner"
const AppSidebar = lazy(() =>
  import("@/components/app-sidebar").then((module) => ({
    default: memo(module.AppSidebar),
  }))
)
import { SettingsDialog } from "@/components/settings/settings-dialog"
import type { SettingsSectionId } from "@/components/settings/sections"
import { onOpenSettings } from "@/lib/settings-open"
import { UpdateNudge } from "@/components/update-nudge"
import { UpdateIndicatorDot } from "@/components/update-indicator"
import { ShareDocumentAction } from "@/components/share-document-action"
import { WorktableAppIcon } from "@/components/worktable-app-icon"
import { useIsMobile } from "@/hooks/use-mobile"
import { useMobileVisualViewport } from "@/hooks/use-mobile-visual-viewport"
import { SidebarContext } from "@/hooks/use-sidebar"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useWorkspace } from "@/lib/queries"
import { themeBootstrapScript } from "@/lib/theme"
import { ThemeProvider, useTheme } from "@/components/theme-provider"
import {
  usePageLifecyclePersistence,
  useDiscardRecovery,
  ReconnectingOverlay,
} from "@/hooks/use-page-lifecycle"
import { PageMetaContext, narrowHeaderAction } from "@/hooks/use-page-meta"
import { Breadcrumb } from "@/components/breadcrumb"
import { PageMenu } from "@/components/page-menu"
import type { PageMeta } from "@/hooks/use-page-meta"
import { onBrowserLogout } from "@/lib/auth-events"
import { useUpdateWaiting } from "@/hooks/use-update-availability"
const Onboarding = lazy(() =>
  import("@/components/onboarding/onboarding").then((module) => ({
    default: module.Onboarding,
  }))
)

interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1.0, viewport-fit=cover",
      },
      { title: "Worktable" },
      {
        name: "description",
        content:
          "AI agent workspace | Dashboards, docs, and data your agents can control",
      },
      {
        name: "theme-color",
        content: THEME_SHELL_COLORS.dark,
      },
      {
        name: "apple-mobile-web-app-capable",
        content: "yes",
      },
      {
        name: "apple-mobile-web-app-status-bar-style",
        content: "black-translucent",
      },
    ],
    links: [
      { rel: "stylesheet", href: appStylesheet },
      { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
      {
        rel: "icon",
        href: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon-180x180.png",
      },
      {
        rel: "manifest",
        href: "/manifest.webmanifest",
      },
    ],
  }),
  ssr: false, // Pure SPA — all rendering happens on the client
  shellComponent: RootShell,
  component: RootLayoutWithProviders,
  pendingComponent: InitialLoader,
  // Do not retain the startup logo after hydration/data are already ready.
  pendingMinMs: 0,
})

// ── HTML Shell (always SSRed / prerendered) ──────────────────

function InitialLoader() {
  return (
    <div className="initial-loader">
      <WorktableAppIcon className="initial-loader-icon" />
    </div>
  )
}

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <DocumentOpeningData />
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        <script dangerouslySetInnerHTML={{ __html: fontBootstrapScript }} />
        <script
          dangerouslySetInnerHTML={{ __html: documentOpeningLayoutScript }}
        />
        <script
          dangerouslySetInnerHTML={{ __html: documentOpeningPreloadScript }}
        />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html { background-color: ${THEME_SHELL_COLORS.dark}; color-scheme: dark; }
              html.light { background-color: ${THEME_SHELL_COLORS.light}; color-scheme: light; }
              body { margin: 0; overflow: hidden; }
              body.loaded { overflow: auto; }
              #worktable-opening-preview:not(:empty) { position: fixed; inset: calc(3rem + env(safe-area-inset-top, 0px)) 0 0; z-index: 10000; background: var(--background); }
              @media (min-width: 768px) { #worktable-opening-preview:not(:empty) { left: var(--worktable-opening-sidebar, 288px); } }
              .initial-loader {
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100dvh;
                flex-direction: column;
                gap: 16px;
              }
              .initial-loader-icon {
                width: 40px;
                height: 40px;
                animation: worktable-startup 1.5s ease-in-out infinite;
              }
              @keyframes worktable-startup {
                0%, 100% { opacity: 0.6; }
                50% { opacity: 1; }
              }
              @media (prefers-reduced-motion: reduce) { .initial-loader-icon { animation: none; } }
              @keyframes loading-bar {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(200%); }
              }
            `,
          }}
        />
      </head>
      <body>
        <DocumentOpening />
        {children}
        <Scripts />
      </body>
    </html>
  )
}

// ── Route Loading Bar ────────────────────────────────────────

function RouteLoadingBar() {
  const isLoading = useRouterState({ select: (s) => s.isLoading })
  if (!isLoading) return null
  return (
    <div className="fixed top-0 right-0 left-0 z-[9999] h-[2px] overflow-hidden">
      <div className="h-full w-1/2 animate-[loading-bar_1s_ease-in-out_infinite] bg-primary" />
    </div>
  )
}

// ── Mobile Sidebar Overlay ───────────────────────────────────

function MobileSidebarOverlay({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden"
    } else {
      document.body.style.overflow = ""
    }
    return () => {
      document.body.style.overflow = ""
    }
  }, [open])

  return (
    <>
      {/* Backdrop */}
      <div
        data-slot="mobile-navigation-backdrop"
        className={`navigation-backdrop fixed inset-0 z-40 transition-opacity duration-200 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
      />
      {/* Drawer (slides from right) — stable shell surface */}
      <div
        data-slot="mobile-navigation-drawer"
        className={`navigation-drawer fixed inset-y-0 right-0 z-50 w-[min(21rem,calc(100vw-2.5rem))] transform overflow-hidden transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <Suspense fallback={null}>
          <AppSidebar />
        </Suspense>
      </div>
    </>
  )
}

function MobileSidebarToggle({ onClick }: { onClick: () => void }) {
  const updateAvailable = useUpdateWaiting()
  const label = updateAvailable
    ? "Toggle sidebar, update available"
    : "Toggle sidebar"

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="relative size-8 shrink-0 text-muted-foreground hover:text-foreground"
    >
      <PanelRight className="size-4" />
      {updateAvailable ? (
        <UpdateIndicatorDot className="absolute top-1.5 right-1.5" />
      ) : null}
    </Button>
  )
}

// ── Root Layout with Providers ───────────────────────────────

function RootLayoutWithProviders() {
  const router = useRouter()
  const queryClient = router.options.context.queryClient
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setHydrated(true)
  }, [])

  // The static SPA shell is built at `/`, while the first browser URL may be
  // any route. Keep the hydration tree independent of route, viewport, theme,
  // and persisted sidebar state; mount the route-aware app immediately after.
  if (!hydrated) return <InitialLoader />

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <WorkspaceStorageGate>
          <RootLayout />
        </WorkspaceStorageGate>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

// ── Root Layout ──────────────────────────────────────────────

function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile)
  const [workspaceChanged, setWorkspaceChanged] = useState(false)
  useEffect(() => {
    const reset = () => setWorkspaceChanged(true)
    window.addEventListener("worktable:workspace-changed", reset)
    return () =>
      window.removeEventListener("worktable:workspace-changed", reset)
  }, [])
  const [pageMeta, setPageMeta] = useState<PageMeta | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>()
  const router = useRouter()
  const { theme } = useTheme()

  // Phase 4: Page lifecycle persistence
  usePageLifecyclePersistence(router)
  const { reconnecting } = useDiscardRecovery()
  useMobileVisualViewport(isMobile)

  // Settings actions can arrive before the deferred sidebar mounts. The shell
  // owns their state and lightweight dialog; tab contents load on first visit.
  useEffect(
    () =>
      onOpenSettings((requested) => {
        setSettingsSection(requested)
        setSettingsOpen(true)
      }),
    []
  )

  // Mark body as loaded
  useEffect(() => {
    document.body.classList.add("loaded")
  }, [])

  useEffect(
    () =>
      onBrowserLogout(() => {
        // Navigation unloads this tab and closes its /ws and /yjs connections.
        window.location.replace("/signed-out")
      }),
    []
  )

  // Tab-title prefix for non-daily workspaces (cheapest unmistakable signal). Keyed on
  // pathname too so it re-applies after navigation, where TanStack's HeadContent resets
  // the document title to the static root "Worktable".
  const workspaceQuery = useWorkspace()
  const workspace = workspaceQuery.data
  const titlePathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => {
    const prefix =
      workspace?.mode === "sandbox"
        ? "Sandbox · "
        : workspace?.mode === "staging"
          ? "Staging · "
          : workspace?.mode === "fixture"
            ? "Fixture · "
            : ""
    document.title = `${prefix}Worktable`
  }, [workspace?.mode, titlePathname])

  // Close sidebar on mobile when route changes
  useEffect(() => {
    if (!isMobile) return

    const unsubscribe = router.subscribe("onBeforeNavigate", () => {
      setSidebarOpen(false)
    })

    return unsubscribe
  }, [isMobile, router])

  // When switching between mobile/desktop, adjust sidebar default
  useEffect(() => {
    setSidebarOpen(!isMobile)
  }, [isMobile])

  const toggle = useCallback(() => {
    setSidebarOpen((prev) => !prev)
  }, [])

  // Desktop sidebar drag-resize; width persists across sessions.
  const sidebarResize = useResizable({
    edge: "right",
    defaultSize: 288,
    minSize: 220,
    maxSize: 480,
    storageKey: "worktable-sidebar-width",
  })

  // Published as a CSS variable on the root layout div for fixed-position UI
  // (e.g. the doc sync pill) that must clear the sidebar but renders too deep
  // in the tree to receive it as a prop. Declarative on purpose: an effect
  // mutating <html> style raced the prerendered shell's hydration and made
  // React discard client state on recovery.
  const effectiveSidebarWidth =
    !isMobile && sidebarOpen ? sidebarResize.size : 0

  // Print always renders on white (see print.css); strip the dark class for
  // the duration of the print job. BlockNote themes off its container's
  // data-color-scheme attribute (not html.dark), so flip that too or rich
  // docs print dark text colors on the white page. Listening on the window
  // covers Cmd+P and the browser menu, not just the in-app Print action.
  useEffect(() => {
    // Some browsers fire beforeprint more than once per print job; capture
    // the pre-print state only on the first and hold it until afterprint,
    // or a repeat would read the already-stripped state and never restore.
    let printState: {
      wasDark: boolean
      darkContainers: Element[]
    } | null = null
    const beforePrint = () => {
      if (printState) return
      printState = {
        wasDark: document.documentElement.classList.contains("dark"),
        darkContainers: [
          ...document.querySelectorAll(
            '.bn-container[data-color-scheme="dark"]'
          ),
        ],
      }
      if (printState.wasDark) document.documentElement.classList.remove("dark")
      for (const el of printState.darkContainers)
        el.setAttribute("data-color-scheme", "light")
    }
    const afterPrint = () => {
      if (!printState) return
      if (printState.wasDark) document.documentElement.classList.add("dark")
      for (const el of printState.darkContainers)
        el.setAttribute("data-color-scheme", "dark")
      printState = null
    }
    window.addEventListener("beforeprint", beforePrint)
    window.addEventListener("afterprint", afterPrint)
    return () => {
      window.removeEventListener("beforeprint", beforePrint)
      window.removeEventListener("afterprint", afterPrint)
    }
  }, [])

  const mainScrollRef = useScrollFade<HTMLElement>(8, { top: false })
  const primaryAction = pageMeta?.primaryAction
  const PrimaryActionIcon = primaryAction?.icon ?? Pencil
  const secondaryAction = pageMeta?.secondaryAction
  const SecondaryActionIcon = secondaryAction?.icon

  // Document metadata updates the header repeatedly during opening. It should
  // not rebuild the whole navigation tree or invalidate its sidebar context.
  const sidebarCtx = useMemo(
    () => ({ open: sidebarOpen, setOpen: setSidebarOpen, toggle }),
    [sidebarOpen, toggle]
  )

  // The login page renders bare, outside the sidebar/header chrome. Keep all
  // hooks above this branch so hook order stays stable across renders.
  if (pathname === "/login") {
    return <Outlet />
  }

  if (workspaceQuery.isPending || workspaceChanged) return <InitialLoader />

  if (workspace?.onboarding?.status === "pending") {
    return (
      <>
        <Suspense fallback={<InitialLoader />}>
          <Onboarding workspace={workspace} />
        </Suspense>
        <Toaster theme={theme} />
      </>
    )
  }

  return (
    <PageMetaContext.Provider value={{ pageMeta, setPageMeta }}>
      <SidebarContext.Provider value={sidebarCtx}>
        <WorkspaceOperationObserver />
        <ReconnectingOverlay show={reconnecting} />
        <div
          data-worktable-app-shell
          data-worktable-sidebar-open={sidebarOpen ? "true" : "false"}
          className="relative flex h-dvh overflow-hidden bg-background text-foreground antialiased"
          style={
            {
              "--app-sidebar-width": `${effectiveSidebarWidth}px`,
            } as CSSProperties
          }
        >
          <RouteLoadingBar />

          {/* Desktop sidebar — glass pane level 1 */}
          {!isMobile && (
            <aside
              className={`desktop-sidebar-surface relative shrink-0 overflow-hidden border-r border-sidebar-border print:hidden ${
                sidebarResize.isResizing
                  ? ""
                  : "transition-[width] duration-300 ease-in-out"
              }`}
              style={{ width: sidebarOpen ? sidebarResize.size : 0 }}
            >
              <div
                className="glass h-full"
                style={{ width: sidebarResize.size }}
              >
                <Suspense fallback={null}>
                  <AppSidebar />
                </Suspense>
              </div>
            </aside>
          )}

          {/* Sidebar resize handle — a sibling of the aside (which clips its
            overflow for the collapse animation) so the grab strip can
            straddle the border instead of sitting on top of the sidebar's
            overlay scrollbar. */}
          {!isMobile && sidebarOpen && (
            <ResizeHandle
              {...sidebarResize.handleProps}
              aria-label="Resize sidebar"
              className="z-40 -translate-x-1/2"
              style={{ left: sidebarResize.size }}
            />
          )}

          {/* Mobile sidebar */}
          {isMobile && (
            <MobileSidebarOverlay
              open={sidebarOpen}
              onClose={() => setSidebarOpen(false)}
            />
          )}

          {/* Main column */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Header */}
            <header
              data-tauri-drag-region="deep"
              data-worktable-app-header
              className="glass sticky top-0 z-30 flex shrink-0 items-center gap-3 border-b border-border/60 px-3 transition-[padding-left] duration-300 ease-in-out select-none sm:pr-4 print:hidden"
              style={{
                background: "oklch(from var(--background) l c h / 0.75)",
                paddingTop: "env(safe-area-inset-top, 0px)",
                minHeight: "calc(3rem + env(safe-area-inset-top, 0px))",
              }}
            >
              {/* Desktop sidebar toggle */}
              {!isMobile && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggle}
                  aria-label="Toggle sidebar"
                  className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <PanelLeft className="size-4" />
                </Button>
              )}

              {/* Logo icon (mobile only) */}
              {isMobile && (
                <Link
                  to="/"
                  aria-label="Worktable home"
                  className="flex items-center"
                >
                  <WorktableAppIcon className="size-7" />
                </Link>
              )}

              {/* Breadcrumb */}
              <div className="min-w-0 flex-1">
                {isMobile ? <PageMenu /> : <Breadcrumb />}
              </div>

              {/* Narrow screens keep one action; the page menu holds the rest. */}
              {secondaryAction &&
                SecondaryActionIcon &&
                (!isMobile || narrowHeaderAction(pageMeta) === "secondary") && (
                  <Button
                    variant={secondaryAction.displayLabel ? "outline" : "ghost"}
                    size={secondaryAction.displayLabel ? "sm" : "icon"}
                    className={
                      secondaryAction.displayLabel
                        ? "h-8 shrink-0 gap-1.5 px-2.5 max-sm:size-8 max-sm:px-0"
                        : "size-8 shrink-0 text-muted-foreground hover:text-foreground"
                    }
                    onClick={secondaryAction.onClick}
                    aria-label={secondaryAction.label}
                    title={secondaryAction.label}
                    disabled={
                      secondaryAction.disabled || secondaryAction.pending
                    }
                  >
                    {secondaryAction.pending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <SecondaryActionIcon className="size-4" />
                    )}
                    {secondaryAction.displayLabel ? (
                      <span className="hidden sm:inline">
                        {secondaryAction.displayLabel}
                      </span>
                    ) : null}
                  </Button>
                )}

              {!isMobile && pageMeta?.annotations && (
                <Button
                  variant={pageMeta.annotations.open ? "secondary" : "ghost"}
                  size="sm"
                  onClick={pageMeta.annotations.onToggle}
                  aria-label={`${pageMeta.annotations.count} open annotations`}
                  aria-pressed={pageMeta.annotations.open}
                  className="h-8 shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                >
                  <MessageSquareText className="size-4" />
                  <span className="text-xs tabular-nums">
                    {pageMeta.annotations.count}
                  </span>
                </Button>
              )}

              {primaryAction && (
                <Button
                  size="sm"
                  className="h-8 shrink-0 gap-1.5 px-2.5"
                  onClick={primaryAction.onClick}
                  aria-label={primaryAction.label}
                  title={primaryAction.label}
                  disabled={primaryAction.disabled || primaryAction.pending}
                >
                  <PrimaryActionIcon className="size-3.5" />
                  <span className="hidden sm:inline">
                    {primaryAction.pending
                      ? (primaryAction.pendingLabel ?? primaryAction.label)
                      : primaryAction.label}
                  </span>
                </Button>
              )}

              {!isMobile && pageMeta?.document && (
                <DocumentLifetimeChip
                  key={`${pageMeta.document.spaceId}:${pageMeta.document.path}`}
                  spaceId={pageMeta.document.spaceId}
                  path={pageMeta.document.path}
                />
              )}

              {!isMobile && pageMeta?.shareTarget && (
                <ShareDocumentAction
                  key={`${pageMeta.shareTarget.kind}:${pageMeta.shareTarget.spaceId}:${pageMeta.shareTarget.artifactKey}`}
                  target={pageMeta.shareTarget}
                />
              )}

              {!isMobile &&
              (pageMeta?.overflowActions?.length || pageMeta?.document) ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label="More actions"
                    title="More actions"
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    render={<button type="button" />}
                  >
                    <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={4}
                    className="min-w-44"
                  >
                    {(pageMeta.overflowActions ?? []).map((action) => {
                      const ActionIcon = action.icon
                      return (
                        <Fragment key={action.id}>
                          {action.separatorBefore ? (
                            <DropdownMenuSeparator />
                          ) : null}
                          <DropdownMenuItem
                            disabled={action.disabled}
                            variant={
                              action.tone === "destructive"
                                ? "destructive"
                                : undefined
                            }
                            onClick={action.onSelect}
                          >
                            <ActionIcon className="mr-2 size-4" />
                            {action.label}
                          </DropdownMenuItem>
                        </Fragment>
                      )
                    })}
                    {pageMeta.document && (
                      <DocumentOrganizeMenuItems
                        spaceId={pageMeta.document.spaceId}
                        path={pageMeta.document.path}
                        separatorBefore={Boolean(
                          pageMeta.overflowActions?.length
                        )}
                      />
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}

              {/* Mobile hamburger on the right */}
              {isMobile && <MobileSidebarToggle onClick={toggle} />}
            </header>

            {/* Main content */}
            <main
              ref={mainScrollRef}
              className="scroll-fade flex-1 overflow-y-auto"
              style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
            >
              <Outlet />
            </main>
          </div>
        </div>
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          initialSection={settingsSection}
        />
        <Toaster theme={theme} />
        {/* After the login guard above, so an unauthenticated page never polls. */}
        <UpdateNudge />
      </SidebarContext.Provider>
    </PageMetaContext.Provider>
  )
}
