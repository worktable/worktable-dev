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
import type { WikiConfig } from "./wiki-config.ts";

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

export function validateDocConventions(input: {
  docPath: string;
  content: string | unknown[];
  links: DocLink[];
  cfg: WikiConfig;
}): DocConventionIssue[] {
  const { docPath, content, links, cfg } = input;
  const issues: DocConventionIssue[] = [];

  const folderDepth = docPath.split("/").length - 1;
  if (folderDepth > cfg.folderDepthBudget) {
    issues.push({
      severity: "warning",
      code: "folder_too_deep",
      message: `Path is nested ${folderDepth} folders deep (budget ${cfg.folderDepthBudget}).`,
      hint: "Deep trees hide docs. Prefer a flatter path that matches the space's structure; rename with worktable_docs_write when needed.",
    });
  }

  if (typeof content === "string") {
    const lines = content.split("\n").length;
    if (lines > cfg.docLengthBudgetLines) {
      issues.push({
        severity: "warning",
        code: "doc_over_length_budget",
        message: `Doc is ${lines} lines (budget ${cfg.docLengthBudgetLines}).`,
        hint: "Keep docs as short as they need to be. Split into focused docs and link the parts by path: [Title](/other-doc).",
      });
    }
    if (!hasMarkdownH1(content)) {
      issues.push({
        severity: "hint",
        code: "missing_h1",
        message: "Doc has no H1 heading.",
        hint: "The first H1 becomes the doc's display title everywhere; without one the filename is used.",
      });
    }
  } else if (Array.isArray(content)) {
    if (content.length > cfg.docLengthBudgetBlocks) {
      issues.push({
        severity: "warning",
        code: "doc_over_length_budget",
        message: `Doc is ${content.length} blocks (budget ${cfg.docLengthBudgetBlocks}).`,
        hint: "Keep docs as short as they need to be. Split into focused docs and link the parts by path: [Title](/other-doc).",
      });
    }
    if (!hasBlockH1(content)) {
      issues.push({
        severity: "hint",
        code: "missing_h1",
        message: "Doc has no H1 heading.",
        hint: "The first H1 becomes the doc's display title everywhere; without one the filename is used.",
      });
    }
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
