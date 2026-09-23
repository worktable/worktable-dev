import { markSettingsSectionVisible } from "@/lib/settings-open"
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  useResponsiveDialog,
} from "@worktable/ui/components/responsive-dialog"
import { Button } from "@worktable/ui/components/button"
import { Badge } from "@worktable/ui/components/badge"
import { cn } from "@worktable/ui/lib/utils"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useScrollFadeX } from "@/hooks/use-scroll-fade-x"
import { useUpdateAvailability } from "@/hooks/use-update-availability"
import {
  DEFAULT_SETTINGS_SECTION_ID,
  getSettingsSections,
  type SettingsSection,
  type SettingsSectionId,
} from "./sections"

// Whether the section a component sits in is the one currently shown. All
// sections stay mounted while the dialog is open (state must survive
// switching), so queries with real-world side effects (e.g. the version query,
// whose route may contact the release host) gate on this instead of mount.
const SectionActiveContext = createContext(false)

export function useSettingsSectionActive(): boolean {
  return useContext(SectionActiveContext)
}

export function SettingsDialog({
  open,
  onOpenChange,
  initialSection,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Section to land on when the dialog opens; defaults to the first one. */
  initialSection?: SettingsSectionId
}) {
  const [activeId, setActiveId] = useState<SettingsSectionId>(
    initialSection ?? DEFAULT_SETTINGS_SECTION_ID
  )

  // Re-derive the landing section on each open transition (guarded setState
  // during render — the supported way to adjust state from a prop change), so
  // a reopen lands on the caller's requested section, or the default.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setActiveId(initialSection ?? DEFAULT_SETTINGS_SECTION_ID)
  }

  // A named-section request can also arrive while the dialog is already open
  // (the update toast's action with Settings sitting on another section) —
  // honor it without an open flip. Only a real request switches; the plain
  // Settings button clearing back to undefined must not yank the section.
  const [prevSection, setPrevSection] = useState(initialSection)
  if (initialSection !== prevSection) {
    setPrevSection(initialSection)
    if (open && initialSection) setActiveId(initialSection)
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      {/* Pin the height on BOTH form factors so switching sections never
          resizes the surface: h-[85dvh] holds the mobile drawer steady
          (sections range from one card to a full connect flow), and the sm:
          override does the same for the desktop dialog. sm:max-h-none drops
          DialogContent's viewport cap so sm:h- governs. sm:p-0 lets the nav
          rail column run edge to edge; each pane brings its own padding (the
          drawer keeps its built-in inset on mobile). The larger md: bounds
          match ResponsiveDialog's desktop breakpoint. */}
      <ResponsiveDialogContent className="h-[85dvh] sm:h-[min(680px,85dvh)] sm:max-h-none sm:max-w-3xl sm:p-0 md:h-[min(800px,90dvh)] md:w-[calc(100%-3rem)] md:max-w-5xl">
        {/* Mounted only while open, so per-session state (update engagement, a
            one-time connection token) is fresh each open — a past update's
            terminal marker can't leak in. ALL sections stay mounted while the
            dialog is open (inactive ones hidden): switching sections must not
            destroy a just-minted one-time token or stop in-flight update
            polling mid-restart. */}
        {open && <SettingsBody activeId={activeId} onSelect={setActiveId} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function SettingsBody({
  activeId,
  onSelect,
}: {
  activeId: SettingsSectionId
  onSelect: (id: SettingsSectionId) => void
}) {
  const { isMobile } = useResponsiveDialog()
  useEffect(() => markSettingsSectionVisible(activeId), [activeId])
  const deploymentQuery = useDeploymentInfo()
  const updateAvailable = useUpdateAvailability() !== null
  const sections = deploymentQuery.data
    ? getSettingsSections(deploymentQuery.data)
    : []
  const active =
    sections.find((section) => section.id === activeId) ?? sections[0]
  // Callback ref (survives conditional rendering) drives the vertical edge fade.
  const scrollRef = useScrollFade<HTMLDivElement>()

  // A requested section may not exist in this deployment (Account locally).
  // Normalize only after the authoritative capability response arrives.
  useEffect(() => {
    if (active && active.id !== activeId) onSelect(active.id)
  }, [active, activeId, onSelect])

  if (!deploymentQuery.data) {
    return (
      <SettingsDeploymentState
        loading={deploymentQuery.isLoading}
        onRetry={() => void deploymentQuery.refetch()}
      />
    )
  }

  // Every deployment has General, so this can only be absent during the
  // unresolved state handled above.
  if (!active) return null

  // The only scroll container. Native scroll keeps overscroll-contain + a stable
  // gutter (base-ui's ScrollArea can't carry either), with scroll-fade masking
  // the edges in place of hard borders. On desktop it spans the full content
  // column so the scrollbar rides the dialog's right edge instead of hugging
  // the cards; the pr-5 keeps content clear of the thumb. Every section stays
  // mounted (inactive hidden) so section state survives switching — see the
  // note at the mount site.
  const content = (
    <div
      ref={scrollRef}
      className={cn(
        "scroll-fade min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]",
        // Mobile: full-bleed past the drawer inset so the scrollbar rides the
        // screen edge instead of floating beside the cards.
        isMobile ? "-mx-5 px-5 pt-4 pb-6" : "pt-4 pr-5 pb-6 pl-6"
      )}
    >
      {sections.map((section) => {
        const Section = section.component
        const isActive = section.id === active.id
        return (
          <div
            key={section.id}
            data-settings-section={section.id}
            hidden={!isActive}
          >
            <SectionActiveContext.Provider value={isActive}>
              <Section />
            </SectionActiveContext.Provider>
          </div>
        )
      })}
    </div>
  )

  if (isMobile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Settings</ResponsiveDialogTitle>
          <ResponsiveDialogDescription
            className={active.description ? undefined : "sr-only"}
          >
            {active.description ?? active.label}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <SettingsTabsMobile
          sections={sections}
          activeId={active.id}
          onSelect={onSelect}
          updateAvailable={updateAvailable}
        />
        {content}
      </div>
    )
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[224px_1fr]">
      {/* The rail column is a full-height quiet surface so the nav reads as a
          grounded region of the dialog, not buttons floating in space. The
          dialog title lives here; the content pane header names the section. */}
      <aside className="flex min-h-0 flex-col gap-3 bg-muted/40 p-3">
        <ResponsiveDialogTitle className="px-2.5 pt-1.5 text-base">
          Settings
        </ResponsiveDialogTitle>
        <ResponsiveDialogDescription className="sr-only">
          Manage this Worktable install.
        </ResponsiveDialogDescription>
        <SettingsNavRail
          sections={sections}
          activeId={active.id}
          onSelect={onSelect}
          updateAvailable={updateAvailable}
        />
      </aside>
      {/* min-w-0: grid children default to min-width auto, so an unwrappable
          mono line (e.g. a connect snippet) would otherwise widen the column
          past the dialog instead of scrolling. */}
      <div className="flex min-h-0 min-w-0 flex-col">
        {/* pr-12 keeps the title clear of the dialog's absolute close button. */}
        <header className="shrink-0 pt-5 pr-12 pl-6">
          <h3 className="text-lg leading-tight font-semibold">
            {active.label}
          </h3>
          {active.description ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {active.description}
            </p>
          ) : null}
        </header>
        {content}
      </div>
    </div>
  )
}

function SettingsDeploymentState({
  loading,
  onRetry,
}: {
  loading: boolean
  onRetry: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <ResponsiveDialogTitle className="text-base">
        Settings
      </ResponsiveDialogTitle>
      <ResponsiveDialogDescription className="mt-1">
        Manage this Worktable.
      </ResponsiveDialogDescription>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground" role="status">
          {loading
            ? "Loading settings…"
            : "Couldn’t determine which settings apply to this Worktable."}
        </p>
        {!loading ? (
          <Button type="button" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  )
}

// Desktop: a vertical list of ghost rows on the rail surface. One shared pill
// slides behind the active row (measured, not index math, so it tracks real
// layout); everything else moves only through color transitions.
function SettingsNavRail({
  sections,
  activeId,
  onSelect,
  updateAvailable,
}: {
  sections: SettingsSection[]
  activeId: SettingsSectionId
  onSelect: (id: SettingsSectionId) => void
  updateAvailable: boolean
}) {
  const itemRefs = useRef(new Map<SettingsSectionId, HTMLButtonElement>())
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null)
  const scrollRef = useScrollFade<HTMLElement>()
  const sectionIds = sections.map((section) => section.id).join(",")
  const groups = ["Workspace", "Preferences", "Data", "Support"] as const

  useLayoutEffect(() => {
    const el = itemRefs.current.get(activeId)
    if (!el) return
    setPill({ top: el.offsetTop, height: el.offsetHeight })
    el.scrollIntoView({ block: "nearest" })
  }, [activeId, sectionIds])

  return (
    <nav
      ref={scrollRef}
      aria-label="Settings"
      className="scroll-fade min-h-0 flex-1 overflow-y-auto"
    >
      <div className="relative space-y-4">
        {pill && (
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 rounded-lg bg-sidebar-accent transition-[transform,height] duration-180 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{
              transform: `translateY(${pill.top}px)`,
              height: pill.height,
            }}
          />
        )}
        {groups.map((group) => {
          const groupSections = sections.filter(
            (section) => section.group === group
          )
          if (groupSections.length === 0) return null
          return (
            <section
              key={group}
              aria-label={group}
              className="flex flex-col gap-0.5"
            >
              <h3 className="px-2.5 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
                {group}
              </h3>
              {groupSections.map((section) => {
                const Icon = section.icon
                const isActive = section.id === activeId
                return (
                  <button
                    key={section.id}
                    ref={(el) => {
                      if (el) itemRefs.current.set(section.id, el)
                      else itemRefs.current.delete(section.id)
                    }}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => onSelect(section.id)}
                    className={cn(
                      "relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-180",
                      isActive
                        ? "font-medium text-primary-text"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="flex-1 text-left">{section.label}</span>
                    {updateAvailable && section.id === "system" ? (
                      <Badge variant="info">Update</Badge>
                    ) : null}
                  </button>
                )
              })}
            </section>
          )
        })}
      </div>
    </nav>
  )
}

// Mobile: a horizontally scrollable row of chips, bled to the screen edges so
// they scroll to the true edge. The active chip speaks the same language as
// the desktop rail pill (cobalt tint + cobalt text). The edge fade is the
// overflow signal, so the strip's own scrollbar stays hidden, and the active
// chip is kept centered — one tapped half-clipped at the edge must not stay
// there. Plain buttons (not role=tab): the section panels live elsewhere, so
// tablist semantics were never truly wired; aria-pressed is the honest state.
function SettingsTabsMobile({
  sections,
  activeId,
  onSelect,
  updateAvailable,
}: {
  sections: SettingsSection[]
  activeId: SettingsSectionId
  onSelect: (id: SettingsSectionId) => void
  updateAvailable: boolean
}) {
  const fadeRef = useScrollFadeX<HTMLDivElement>()
  const stripRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef(new Map<SettingsSectionId, HTMLButtonElement>())
  // The horizontal twin of the desktop rail's sliding pill (measured, not
  // index math — chip widths vary with their labels).
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const el = itemRefs.current.get(activeId)
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth })
  }, [activeId])

  useEffect(() => {
    stripRef.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: "smooth",
    })
  }, [activeId])

  return (
    <div
      ref={(el) => {
        stripRef.current = el
        fadeRef(el)
      }}
      className="scroll-fade-x scrollbar-none -mx-5 shrink-0 overflow-x-auto px-5 pb-3"
    >
      <div className="relative flex w-max items-center gap-1.5">
        {pill && (
          <div
            aria-hidden
            className="absolute inset-y-0 left-0 rounded-full bg-sidebar-accent transition-[transform,width] duration-180 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{
              transform: `translateX(${pill.left}px)`,
              width: pill.width,
            }}
          />
        )}
        {sections.map((section) => {
          const Icon = section.icon
          const isActive = section.id === activeId
          return (
            <button
              key={section.id}
              ref={(el) => {
                if (el) itemRefs.current.set(section.id, el)
                else itemRefs.current.delete(section.id)
              }}
              type="button"
              aria-pressed={isActive}
              onClick={() => onSelect(section.id)}
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-sm whitespace-nowrap transition-colors duration-180",
                isActive
                  ? "font-medium text-primary-text"
                  : "text-muted-foreground active:text-foreground"
              )}
            >
              <Icon className="size-4 shrink-0" />
              {section.label}
              {updateAvailable && section.id === "system" ? (
                <Badge variant="info">Update</Badge>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
