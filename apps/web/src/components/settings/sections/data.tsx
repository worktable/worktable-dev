import { useId, type ReactNode } from "react"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { BackupsSection } from "./backups"
import { HistorySection } from "./history"
import { PortabilitySection } from "./portability"

// The Data section: how long versions are kept, Cloud backups, and moving the
// whole Worktable in or out. Each part shows where this deployment offers it.
export function DataSection() {
  const deployment = useDeploymentInfo().data
  const capabilities = deployment?.capabilities
  return (
    <div className="flex flex-col gap-6">
      {capabilities?.historySettings ? (
        <DataGroup title="History">
          <HistorySection />
        </DataGroup>
      ) : null}
      {deployment?.mode === "cloud" ? (
        <DataGroup title="Backups">
          <BackupsSection />
        </DataGroup>
      ) : null}
      {capabilities?.workspacePortability ? (
        <DataGroup title="Import & Export">
          <PortabilitySection />
        </DataGroup>
      ) : null}
    </div>
  )
}

function DataGroup({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3 id={id} className="text-sm font-medium text-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}
