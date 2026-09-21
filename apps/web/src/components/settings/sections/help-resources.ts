import type { LucideIcon } from "lucide-react"
import { BookOpen, FileText, ShieldCheck } from "lucide-react"
import type { DeploymentMode } from "@/lib/system-api"

export interface HelpResource {
  label: string
  href: string
  icon: LucideIcon
}

export function getHelpResources(mode: DeploymentMode): HelpResource[] {
  const productOrigin =
    mode === "cloud"
      ? "https://www.worktable.cloud"
      : "https://www.worktable.dev"

  return [
    {
      label: "Documentation",
      href: "https://docs.worktable.dev/",
      icon: BookOpen,
    },
    {
      label: "Privacy policy",
      href: `${productOrigin}/privacy`,
      icon: ShieldCheck,
    },
    {
      label: "Terms",
      href: `${productOrigin}/terms`,
      icon: FileText,
    },
  ]
}
