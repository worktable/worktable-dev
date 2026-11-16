import type { ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CLOUD_PERSONAL_PLAN } from "@worktable/hosted-contract"
import { Button } from "@worktable/ui/components/button"
import { Card, CardContent } from "@worktable/ui/components/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { HelpLink } from "@worktable/ui/components/help-band"
import { toast } from "@worktable/ui/components/sonner"
import {
  AppWindow,
  ArrowUpRight,
  Bot,
  ChevronRight,
  Clock3,
  Database,
  ExternalLink,
  FileText,
  Folder,
  Globe,
  History,
  Inbox,
  LayoutDashboard,
  Library,
  Lightbulb,
  Link,
  ListChecks,
  Mail,
  MessageCircle,
  MessageSquareText,
  Paperclip,
  Pencil,
  Reply,
  Users,
  Waypoints,
  type LucideIcon,
} from "lucide-react"
import { HelpMark } from "@/components/help/help-tip"
import { useDeploymentInfo, useHelpEnabled } from "@/hooks/use-deployment-info"
import {
  docsUrl,
  TRY_NEXT_COPY,
  type Concept,
  type ConceptId,
} from "@/lib/help/registry"
import { visibleConcepts } from "@/lib/help/settings-help"
import { saveHelp, useHelpContext } from "@/lib/help/state"
import { tryNextProgress, tryNextStatus } from "@/lib/help/try-next"
import { openWelcome } from "@/lib/help/welcome-open"
import { canInvite, usePersonalSetup } from "@/lib/setup"
import { getHelpResources, type HelpResource } from "./help-resources"

export function HelpSection() {
  const deployment = useDeploymentInfo().data
  const resources = getHelpResources(deployment?.mode ?? "self-managed")
  const helpEnabled = useHelpEnabled()

  return (
    <div className="flex flex-col gap-6">
      {helpEnabled && <HelpGuide />}

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Support</h3>
        <Card size="sm">
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                How can we help?
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {CLOUD_PERSONAL_PLAN.supportEmail}
              </p>
            </div>
            <Button
              size="sm"
              nativeButton={false}
              render={<a href={`mailto:${CLOUD_PERSONAL_PLAN.supportEmail}`} />}
            >
              <Mail aria-hidden className="size-4" />
              Contact support
            </Button>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Resources</h3>
        <ListCard>
          {resources.map((resource) => (
            <HelpResourceLink key={resource.label} {...resource} />
          ))}
        </ListCard>
      </section>
    </div>
  )
}

const ROW =
  "flex min-h-11 items-center gap-3 border-b border-border px-3 py-2.5 text-sm text-foreground last:border-b-0"

function ListCard({ children }: { children: ReactNode }) {
  return (
    <Card size="sm" className="data-[size=sm]:gap-0 data-[size=sm]:py-0">
      {children}
    </Card>
  )
}

/** Welcome, Next Steps, tips and How Worktable Works (Preview only). */
function HelpGuide() {
  const queryClient = useQueryClient()
  const { setup, conditions } = useHelpContext()
  const { person } = usePersonalSetup()
  const progress = tryNextProgress(
    tryNextStatus(setup, {
      canInvite: canInvite(person),
      links: conditions.links === true,
    })
  )
  const showNextSteps = useMutation({
    mutationFn: () => saveHelp(queryClient, { tryNextHidden: false }),
    onError: () => toast.error("Couldn’t show Next Steps."),
  })
  const resetTips = useMutation({
    mutationFn: () => saveHelp(queryClient, { resetAll: true }),
    onSuccess: () => toast.success("Tips will show again."),
    onError: () => toast.error("Couldn’t show tips again."),
  })

  return (
    <>
      <section className="flex flex-col gap-3" aria-label="Getting help">
        <ListCard>
          <Row
            icon={<HelpMark />}
            name="Welcome"
            line="What Worktable gives you"
          >
            <Button variant="outline" size="sm" onClick={openWelcome}>
              Show Again
            </Button>
          </Row>
          <Row
            icon={<ListChecks aria-hidden className="size-4" />}
            name={TRY_NEXT_COPY.title}
            line={`${progress.done} of ${progress.total} done`}
          >
            {setup.tryNextHidden ? (
              <Button
                variant="outline"
                size="sm"
                disabled={showNextSteps.isPending}
                onClick={() => showNextSteps.mutate()}
              >
                Show on Home
              </Button>
            ) : null}
          </Row>
          <Row
            icon={<Lightbulb aria-hidden className="size-4" />}
            name="Tips"
            line="Each tip shows where it helps."
          >
            <Button
              variant="outline"
              size="sm"
              disabled={resetTips.isPending}
              onClick={() => resetTips.mutate()}
            >
              Show All Tips
            </Button>
          </Row>
        </ListCard>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">
          How Worktable Works
        </h3>
        <ListCard>
          {visibleConcepts(conditions).map((concept) => (
            <ConceptRow key={concept.id} concept={concept} />
          ))}
        </ListCard>
      </section>
    </>
  )
}

function Row({
  icon,
  name,
  line,
  children,
}: {
  icon: ReactNode
  name: string
  line?: string
  children?: ReactNode
}) {
  return (
    <div className={ROW}>
      <span className="flex shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{name}</span>
        {line ? (
          <span className="block text-muted-foreground">{line}</span>
        ) : null}
      </span>
      {children ? <span className="shrink-0">{children}</span> : null}
    </div>
  )
}

const CONCEPT_ICONS: Record<ConceptId, LucideIcon> = {
  worktable: LayoutDashboard,
  agents: Bot,
  spaces: Folder,
  docs: FileText,
  "html-docs": AppWindow,
  drawings: Pencil,
  files: Paperclip,
  records: Database,
  comments: MessageSquareText,
  threads: MessageCircle,
  pending: Inbox,
  library: Library,
  "temporary-docs": Clock3,
  versions: History,
  "share-links": Link,
  "who-can-see-it": Users,
  "agent-replies": Reply,
  "linked-work": Waypoints,
  "worktable-link": Globe,
}


function ConceptRow({ concept }: { concept: Concept }) {
  const Icon = CONCEPT_ICONS[concept.id]
  return (
    <Collapsible className="border-b border-border last:border-b-0">
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-surface-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset [&[data-panel-open]>svg:last-child]:rotate-90">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground">
            {concept.name}
          </span>
          <span className="block text-muted-foreground">{concept.short}</span>
        </span>
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-250 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col items-start gap-2 pr-3 pb-3 pl-10 text-sm">
          <p className="leading-relaxed text-muted-foreground">
            {concept.full}
          </p>
          <HelpLink href={docsUrl(concept.docs)}>
            Learn More
            <ArrowUpRight aria-hidden className="size-3.5" />
          </HelpLink>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function HelpResourceLink({ label, href, icon: Icon }: HelpResource) {
  return (
    <a
      className="group flex min-h-11 items-center gap-3 border-b border-border px-3 py-2.5 text-sm text-foreground transition-colors last:border-b-0 hover:bg-surface-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 font-medium">{label}</span>
      <ExternalLink
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary-text"
      />
    </a>
  )
}
