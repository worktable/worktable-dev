import { CLOUD_PERSONAL_PLAN } from "@worktable/hosted-contract"
import { Button } from "@worktable/ui/components/button"
import { Card, CardContent } from "@worktable/ui/components/card"
import { ExternalLink, Mail } from "lucide-react"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { getHelpResources, type HelpResource } from "./help-resources"

export function HelpSection() {
  const deployment = useDeploymentInfo().data
  const resources = getHelpResources(deployment?.mode ?? "self-managed")

  return (
    <div className="flex flex-col gap-6">
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
        <Card size="sm" className="data-[size=sm]:gap-0 data-[size=sm]:py-0">
          {resources.map((resource) => (
            <HelpResourceLink key={resource.label} {...resource} />
          ))}
        </Card>
      </section>
    </div>
  )
}

function HelpResourceLink({ label, href, icon: Icon }: HelpResource) {
  return (
    <a
      className="group flex min-h-11 items-center gap-3 border-b border-border px-3 py-2.5 text-sm text-foreground transition-colors last:border-b-0 hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset"
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
