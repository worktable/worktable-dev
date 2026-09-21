/**
 * Worktable Labs — fixture definitions (the in-repo catalog).
 *
 * Each fixture is a pure builder function over a {@link FixtureBuilder}. Content is
 * realistic but private-context-free, and small enough to understand quickly. Add new
 * fixtures (persona starters, behavior fixtures) here; the CLI iterates this registry.
 */
import { blockDoc } from "./blocks.ts";
import type { FixtureBuilder } from "./harness.ts";
import { PERSONA_FIXTURES } from "./personas.ts";

export interface FixtureDef {
  name: string;
  /** What product behavior this fixture exists to prove. */
  proves: string;
  workspace: { id: string; name: string };
  build(b: FixtureBuilder): Promise<void>;
}

const basicDocs: FixtureDef = {
  name: "basic-docs",
  proves: "seed→sandbox→open path, nested docs, both md + BlockNote formats, deterministic generation",
  workspace: { id: "ws_fixture_basic_docs", name: "Basic Docs" },
  async build(b: FixtureBuilder) {
    await b.space({ id: "notes", name: "Notes", description: "A tiny starter space with a few docs." });
    await b.docMd("notes", "readme",
      "# Notes\n\nA small, self-contained workspace fixture. It exists to prove the seed→sandbox→open path and that both Markdown and BlockNote docs survive a copy.\n");
    await b.docMd("notes", "guide/getting-started",
      "# Getting started\n\nThis doc is nested under `guide/` to prove nested doc paths round-trip.\n\n- Open it in the UI\n- Confirm the path renders\n");
    await b.docJson("notes", "ideas",
      blockDoc(
        { id: "h-ideas", type: "heading", text: "Ideas", level: 1 },
        { id: "p-ideas-1", type: "paragraph", text: "A BlockNote (.json) doc, to prove rich docs rebuild from the portable file." },
      ));
  },
};

const wikiLinks: FixtureDef = {
  name: "wiki-links",
  proves:
    "doc→doc links + backlinks (md and BlockNote), broken-link and orphan reporting, backlinkCount in lists, freshness/trust signals starting honest (unreviewed) and flipping live on edit/review",
  workspace: { id: "ws_fixture_wiki_links", name: "Wiki Links" },
  async build(b: FixtureBuilder) {
    await b.space({
      id: "atlas",
      name: "Field Atlas",
      description: "A small interlinked doc set for demonstrating links, backlinks, and trust signals.",
    });

    await b.docMd("atlas", "overview", [
      "# Field Atlas",
      "",
      "A hub doc for the link-graph demo. Every doc here starts **unreviewed** (fixtures carry no edit history), so trust signals begin honest — edit or review a doc in the UI and watch them flip.",
      "",
      "Try, over MCP or REST:",
      "",
      "- `worktable_docs_read` action `read` on this doc → `links` below resolve, except the changelog",
      "- `worktable_docs_read` action `read` on [the API reference](/reference/api) → two `backlinks`",
      "- `worktable_docs_read` action `list` → `backlinkCount` per doc; the scratchpad has none",
      "- Open a doc in the UI, then read it again → `humanReviewed` flips true; let an agent edit it → flips back",
      "",
      "## Contents",
      "",
      "- [Setup guide](/guides/setup) — absolute link from the docs root",
      "- [Usage guide](/guides/usage)",
      "- [API reference](/reference/api)",
      "- [Changelog](/reference/changelog) — deliberately unwritten: a legal broken link",
    ].join("\n"));

    await b.docMd("atlas", "guides/setup", [
      "# Setup guide",
      "",
      "Links here prove relative resolution: [usage](usage) resolves against this doc's folder, and [back to the atlas](../overview) climbs one level.",
      "",
      "```",
      "[this link](/inside-a-fence) must NOT register — fenced code is skipped",
      "```",
    ].join("\n"));

    await b.docMd("atlas", "guides/usage", [
      "# Usage guide",
      "",
      "Cross-folder relative link: see the [API reference](../reference/api). Extensions are tolerated too: [setup](./setup.md).",
    ].join("\n"));

    await b.docMd("atlas", "reference/api", [
      "# API reference",
      "",
      "This doc links to nothing, but the overview and usage guide link here — read it to see both `backlinks`.",
    ].join("\n"));

    await b.docMd("atlas", "orphan-scratchpad", [
      "# Scratchpad",
      "",
      "Nothing links to this doc: it shows up with `backlinkCount: 0` and as an orphan in the space link graph (future lint will flag it).",
    ].join("\n"));

    // A BlockNote doc with an inline link, proving extraction works for rich docs
    // (not just markdown) — the link node lives in inline content, not body text.
    await b.docJson("atlas", "roadmap", [
      ...blockDoc({ id: "h-roadmap", type: "heading", text: "Roadmap", level: 1 }),
      {
        id: "p-roadmap-1",
        type: "paragraph",
        props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
        content: [
          { type: "text", text: "Rich docs link too: ", styles: {} },
          {
            type: "link",
            href: "/overview",
            content: [{ type: "text", text: "back to the atlas", styles: {} }],
          },
        ],
        children: [],
      },
    ]);

    b.annotation("atlas", {
      id: "ann-wiki-links-demo",
      docPath: "overview",
      category: "instruction",
      body:
        "Demo instruction for agents: read this doc's links, confirm /reference/changelog is reported broken, and reply here with the scratchpad's backlink count.",
      labels: ["demo"],
    });
  },
};

export const FIXTURES: Record<string, FixtureDef> = Object.fromEntries(
  [basicDocs, wikiLinks, ...PERSONA_FIXTURES].map((f) => [f.name, f]),
);

export function getFixture(name: string): FixtureDef {
  const def = FIXTURES[name];
  if (!def) {
    throw new Error(`unknown fixture: ${name}. Known: ${Object.keys(FIXTURES).join(", ")}`);
  }
  return def;
}
