import type { ReactNode } from "react"
import { Card } from "@worktable/ui/components/card"

export function SettingsGroup({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <Card className="gap-3 px-4">{children}</Card>
    </section>
  )
}
