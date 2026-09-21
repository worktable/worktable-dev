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
}

export const TABS: DocsTab[] = [
  {
    id: "docs",
    label: "Documentation",
    href: "/",
    prefixes: ["/start", "/concepts", "/guides"],
    groups: ["Start", "Concepts", "Guides"],
  },
  {
    id: "agents",
    label: "Agents",
    href: "/agents/overview/",
    prefixes: ["/agents"],
    groups: ["Agents"],
  },
  {
    id: "reference",
    label: "Reference",
    href: "/reference/cli/",
    prefixes: ["/reference"],
    groups: ["Reference"],
  },
  {
    id: "changelog",
    label: "Changelog",
    href: "/whats-new/",
    prefixes: ["/whats-new"],
    groups: ["Project"],
  },
]

/** Resolve which tab a pathname belongs to. Unmatched paths fall back to Documentation. */
export function tabForPath(pathname: string): DocsTab {
  const match = TABS.find((tab) =>
    tab.prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)),
  )
  return match ?? TABS[0]!
}
