// ============================================================
// Write-time doc convention guidance (MCP writes only)
// ============================================================
//
// Mirrors the widget validation pattern (widget-authoring.ts), with
// one deliberate difference: nothing here blocks. Agents are guided
// through instructions and tool responses, not policed — every issue
// is a warning or hint returned alongside a successful write, and
// the agent is expected to act on it. Humans writing through the UI
// never see this path at all.

import type { DocLink } from "./link-graph.ts";

export interface DocConventionIssue {
  severity: "hint" | "warning";
  code: string;
  message: string;
  hint?: string;
}

function hasMarkdownH1(markdown: string): boolean {
  return /^#\s+\S/m.test(markdown);
}

function hasBlockH1(blocks: unknown[]): boolean {
  return blocks.some((block) => {
    if (!block || typeof block !== "object") return false;
    const b = block as { type?: unknown; props?: { level?: unknown } };
    return b.type === "heading" && (b.props?.level === 1 || b.props?.level === undefined);
  });
}

const MISSING_H1: DocConventionIssue = {
  severity: "hint",
  code: "missing_h1",
  message: "Doc has no H1 heading.",
  hint: "The first H1 becomes the doc's display title everywhere; without one the filename is used.",
};

export function validateDocConventions(input: {
  content: string | unknown[];
  links: DocLink[];
}): DocConventionIssue[] {
  const { content, links } = input;
  const issues: DocConventionIssue[] = [];

  if (typeof content === "string") {
    if (!hasMarkdownH1(content)) issues.push(MISSING_H1);
  } else if (Array.isArray(content)) {
    if (!hasBlockH1(content)) issues.push(MISSING_H1);
  }

  const broken = links.filter((link) => !link.resolved);
  if (broken.length > 0) {
    issues.push({
      severity: "warning",
      code: "broken_outbound_link",
      message: `Links to ${broken.length === 1 ? "a doc that does not exist" : `${broken.length} docs that do not exist`}: ${broken.map((l) => `/${l.resolvedPath}`).join(", ")}.`,
      hint: "Create the missing docs, or fix the link targets if they moved.",
    });
  }

  return issues;
}
