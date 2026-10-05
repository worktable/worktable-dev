/**
 * Header tab model. Tabs partition the sidebar config's top-level groups;
 * `groups` names must match the group labels in astro.config.mjs sidebar.
 */
export interface DocsTab {
  id: string
  label: string
  href: string
  prefixes: string[]
  groups: string[]
  secondary?: boolean
}

export const TABS: DocsTab[] = [
  {
    id: "docs",
    label: "User guide",
    href: "/",
    prefixes: ["/start", "/guides", "/workflows"],
    groups: ["Get started", "Workflows", "Use Worktable", "Manage Worktable"],
  },
  {
    id: "agents",
    label: "Agents",
    href: "/agents/overview/",
    prefixes: ["/agents"],
    groups: ["Agent setup", "Agent workflows"],
  },
  {
    id: "reference",
    label: "Reference",
    href: "/reference/cli/",
    prefixes: ["/reference"],
    groups: ["Installation", "Agent tools", "Data and access"],
  },
  {
    id: "contributing",
    label: "Contributing",
    href: "/contributing/",
    prefixes: ["/contributing"],
    groups: ["Contributing"],
    secondary: true,
  },
  {
    id: "changelog",
    label: "Changelog",
    href: "/whats-new/",
    prefixes: ["/whats-new"],
    groups: ["Project"],
    secondary: true,
  },
]

/** Resolve which tab a pathname belongs to. Unmatched paths fall back to Documentation. */
export function tabForPath(pathname: string): DocsTab {
  const match = TABS.find((tab) =>
    tab.prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)),
  )
  return match ?? TABS[0]!
}
