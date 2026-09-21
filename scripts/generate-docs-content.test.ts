import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildProgram } from "../apps/cli/src/index.ts";
import {
  escapeMdText,
  renderCliCommandsPage,
  renderHtmlRuntimePage,
  renderMcpToolsPage,
  removeRetiredGeneratedPages,
  renderWhatsNewPage,
} from "./generate-docs-content.ts";

const root = join(import.meta.dir, "..");

// Markdown treats a bare <token> as an HTML tag and drops it at render time.
// Every generated page must carry `<` only inside inline code, fenced code,
// or HTML comments (which are intentionally invisible).
function bareAngleBrackets(markdown: string): string[] {
  const withoutFences = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?:details|summary)>/g, "");
  const offenders: string[] = [];
  for (const line of withoutFences.split("\n")) {
    const outsideCode = line
      .split(/(`[^`]*`)/)
      .filter((_, i) => i % 2 === 0)
      .join("");
    if (/(?<!\\)</.test(outsideCode)) offenders.push(line);
  }
  return offenders;
}

function pages(): Record<string, string> {
  const tools = JSON.parse(readFileSync(join(root, "mcp-tools.json"), "utf8"));
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  return {
    "mcp-tools": renderMcpToolsPage(tools),
    "cli-commands": renderCliCommandsPage(buildProgram() as never),
    "whats-new": renderWhatsNewPage(changelog),
    "html-doc-runtime": renderHtmlRuntimePage(),
  };
}

describe("generate-docs-content", () => {
  test("escapes < outside code spans, leaves code spans alone", () => {
    expect(escapeMdText("pass <spaceId> to `worktable_docs_read <raw>`")).toBe(
      "pass \\<spaceId> to `worktable_docs_read <raw>`"
    );
  });

  test("no generated page carries a bare < outside code", () => {
    for (const [name, content] of Object.entries(pages())) {
      expect({ page: name, offenders: bareAngleBrackets(content) }).toEqual({
        page: name,
        offenders: [],
      });
    }
  });

  test("every page has frontmatter title and the generated-page marker", () => {
    for (const content of Object.values(pages())) {
      expect(content.startsWith("---\ntitle:")).toBe(true);
      expect(content).toContain("<!-- Generated at build time from");
    }
  });

  test("whats-new excludes [Unreleased] and CHANGELOG HTML comments", () => {
    const page = pages()["whats-new"];
    expect(page).not.toContain("Unreleased");
    const withoutMarker = page
      .split("\n")
      .filter((line) => !line.startsWith("<!-- Generated at build time"))
      .join("\n");
    expect(withoutMarker).not.toContain("<!--");
    expect(page).toMatch(/## \d+\.\d+\.\d+ — \d{4}-\d{2}-\d{2}/);
  });

  test("cli-commands skips hidden commands and options", () => {
    const page = pages()["cli-commands"];
    expect(page).not.toContain("worktable mcp stdio");
    expect(page).not.toContain("--no-open");
    expect(page).not.toContain("--bind`");
    expect(page).toContain("## worktable launch");
    expect(page).toContain("### worktable service logs");
  });

  test("mcp-tools covers every registry entry", () => {
    const tools = JSON.parse(readFileSync(join(root, "mcp-tools.json"), "utf8")) as Array<{
      name: string;
    }>;
    const page = pages()["mcp-tools"];
    for (const tool of tools) {
      expect(page).toContain(`### ${tool.name}`);
    }
  });

  test("removes the retired generated orientation page from reused checkouts", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "worktable-docs-generation-"));
    const retiredPage = join(
      tempRoot,
      "apps/docs/src/content/docs/agents/orientation.md"
    );
    try {
      mkdirSync(dirname(retiredPage), { recursive: true });
      writeFileSync(retiredPage, "stale privileged guidance");

      removeRetiredGeneratedPages(tempRoot);

      expect(existsSync(retiredPage)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
