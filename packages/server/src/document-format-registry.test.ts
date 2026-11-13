import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { DocumentFormatId, DocumentTextProjection } from "@worktable/types"
import {
  BUILTIN_DOCUMENT_FORMATS,
  DOCUMENT_RENDER_DISPOSITIONS,
  DocumentFormatRegistry,
  createBuiltinDocumentFormatRegistry,
  type DocumentOperationBudget,
} from "./document-format-registry.ts"
import { canonicalizeBlocks, serverSchema } from "./blocknote.ts"
import { markdownToBlocks } from "./markdown.ts"
import { buildWhatAgentsCanMakeBlocks } from "./starter-space.ts"

function adapter(
  id: string,
  extensions: string[],
  sourceVersions: number[] = [1]
) {
  return {
    id: id as DocumentFormatId,
    extensions,
    sourceVersions,
    rendererKey: null,
    renderDisposition: DOCUMENT_RENDER_DISPOSITIONS.attachmentOnly,
    capabilities: {
      authoring: "none" as const,
      publicProjection: "none" as const,
      execution: "none" as const,
    },
    versionedCompanionKeys: [],
    portableState: "none" as const,
  }
}

describe("document format registry", () => {
  it("derives support from trusted registered source versions", () => {
    const registry = createBuiltinDocumentFormatRegistry()
    expect(
      registry.health({
        id: BUILTIN_DOCUMENT_FORMATS.markdown,
        sourceVersion: 1,
      })
    ).toBe("supported")
    expect(
      registry.health({
        id: BUILTIN_DOCUMENT_FORMATS.markdown,
        sourceVersion: 2,
      })
    ).toBe("unsupported-version")
    expect(
      registry.health({
        id: "future.canvas" as DocumentFormatId,
        sourceVersion: 1,
      })
    ).toBe("unsupported-format")
  })

  it("rejects duplicate ids, extensions, and ambiguous compound extensions", () => {
    expect(
      () => new DocumentFormatRegistry([adapter("markdown", [".mdx"])])
    ).toThrow("format ids must be lowercase namespaced identifiers")

    expect(
      () =>
        new DocumentFormatRegistry([
          adapter("future.one", [".one"]),
          adapter("future.one", [".two"]),
        ])
    ).toThrow("duplicate document format id")

    expect(
      () =>
        new DocumentFormatRegistry([
          adapter("future.one", [".future"]),
          adapter("future.two", [".future"]),
        ])
    ).toThrow("ambiguous document extensions")

    expect(
      () =>
        new DocumentFormatRegistry([
          adapter("future.json", [".json"]),
          adapter("future.scene", [".scene.json"]),
        ])
    ).toThrow("ambiguous document extensions")

    expect(
      () =>
        new DocumentFormatRegistry([
          {
            ...adapter("future.canvas", [".canvas"]),
            fileSource: { extension: ".other", discoveryVersion: 1 },
          },
        ])
    ).toThrow("invalid registered file source")

    expect(
      () =>
        new DocumentFormatRegistry([
          {
            ...adapter("future.canvas", [".canvas"]),
            fileSource: { extension: ".canvas", discoveryVersion: 2 },
          },
        ])
    ).toThrow("invalid registered file source")

    expect(
      () =>
        new DocumentFormatRegistry([
          {
            ...adapter("future.canvas", [".canvas"]),
            rendererKey: "canvas",
          },
        ])
    ).toThrow("renderer and disposition disagree")

    expect(
      () =>
        new DocumentFormatRegistry([
          {
            ...adapter("future.canvas", [".canvas"]),
            rendererKey: "canvas",
            renderDisposition: DOCUMENT_RENDER_DISPOSITIONS.trustedComponent,
            capabilities: {
              authoring: "none",
              publicProjection: "none",
              execution: "sandboxed",
            } as const,
          },
        ])
    ).toThrow("execution and disposition disagree")
  })

  it("normalizes extensions and resolves filenames deterministically", () => {
    const registry = new DocumentFormatRegistry([
      adapter("future.canvas", ["canvas"]),
      adapter("future.kit", ["kit"]),
    ])
    expect(registry.extensions()).toEqual([".canvas", ".kit"])
    expect(registry.forFilename("PLAN.CANVAS")?.id).toBe("future.canvas")
    // The file type table's case rule: the Kelvin sign is no "k".
    expect(registry.forFilename("set.KIT")?.id).toBe("future.kit")
    expect(registry.forFilename("set.\u212AIT")).toBeUndefined()
  })

  it("enforces projection budgets and preserves format text semantics", async () => {
    const registry = createBuiltinDocumentFormatRegistry()
    const budget: DocumentOperationBudget = {
      maxInputBytes: 1024,
      maxOutputBytes: 7,
      maxDepth: 16,
      maxElements: 100,
      timeoutMs: 1_000,
    }
    const project = async (
      format: (typeof BUILTIN_DOCUMENT_FORMATS)[keyof typeof BUILTIN_DOCUMENT_FORMATS],
      source: string,
      overrides: Partial<DocumentOperationBudget> = {},
      signal = new AbortController().signal,
      read: () => Promise<Uint8Array> = async () =>
        new TextEncoder().encode(source)
    ): Promise<DocumentTextProjection> => {
      const adapter = registry.get(format)
      if (!adapter?.projectText) throw new Error("missing text projector")
      return adapter.projectText({
        source: { kind: "file", relativePath: "docs/test" },
        read,
        budget: { ...budget, ...overrides },
        signal,
      })
    }

    const truncated = await project(BUILTIN_DOCUMENT_FORMATS.markdown, "🙂🙂")
    expect(truncated.truncated).toBe(true)
    expect(Buffer.byteLength(truncated.text)).toBeLessThanOrEqual(
      budget.maxOutputBytes
    )

    await expect(
      project(
        BUILTIN_DOCUMENT_FORMATS.richText,
        JSON.stringify([{ type: "paragraph", content: [] }]),
        { maxElements: 1 }
      )
    ).rejects.toMatchObject({ reason: "too-large" })
    await expect(
      project(BUILTIN_DOCUMENT_FORMATS.html, "<p>text</p>", {
        maxElements: 1,
      })
    ).rejects.toMatchObject({ reason: "too-large" })

    const controller = new AbortController()
    controller.abort()
    await expect(
      project(BUILTIN_DOCUMENT_FORMATS.markdown, "text", {}, controller.signal)
    ).rejects.toMatchObject({ reason: "temporarily-unavailable" })
    await expect(
      project(
        BUILTIN_DOCUMENT_FORMATS.markdown,
        "text",
        { timeoutMs: 10 },
        new AbortController().signal,
        () => new Promise<Uint8Array>(() => {})
      )
    ).rejects.toMatchObject({ reason: "temporarily-unavailable" })

    const markdown = await project(
      BUILTIN_DOCUMENT_FORMATS.markdown,
      [
        "\uFEFF# Visible",
        "# C#",
        "### Closed heading ###",
        "````",
        "```",
        "# Code, not a heading",
        "````",
        "## Also visible",
      ].join("\n"),
      { maxOutputBytes: 1_024 }
    )
    expect(markdown.text.startsWith("# Visible")).toBe(true)
    expect(markdown.headings).toEqual([
      "Visible",
      "C#",
      "Closed heading",
      "Also visible",
    ])

    const code = "  key:\n    child\n"
    const rich = await project(
      BUILTIN_DOCUMENT_FORMATS.richText,
      `\uFEFF${JSON.stringify([
        { type: "codeBlock", content: [{ type: "text", text: code }] },
      ])}`,
      { maxOutputBytes: 1_024 }
    )
    expect(rich.text).toBe(code)

    const html = await project(
      BUILTIN_DOCUMENT_FORMATS.html,
      "<title>Dashboard</title><body>Ready<p hidden>Secret</p><table><tr><td>Status</td><td>Ready</td></tr></table></body>",
      { maxOutputBytes: 1_024 }
    )
    expect(html.text).toBe("Dashboard\nReady\nStatus\nReady")

    const preformattedHtml = await project(
      BUILTIN_DOCUMENT_FORMATS.html,
      "<p>Before</p><pre>  key:\n    child\n</pre><p>After</p>",
      { maxOutputBytes: 1_024 }
    )
    expect(preformattedHtml.text).toBe("Before\n  key:\n    child\nAfter")

    const exactHtmlBudget = await project(
      BUILTIN_DOCUMENT_FORMATS.html,
      "<body>\n  <p>1234567</p>\n</body>"
    )
    expect(exactHtmlBudget).toMatchObject({
      text: "1234567",
      truncated: false,
    })
  })

  it("takes JSON as a rich-text Doc only when it holds Doc blocks", async () => {
    const registry = createBuiltinDocumentFormatRegistry()
    const richText = registry.get(BUILTIN_DOCUMENT_FORMATS.richText)!
    const budget: DocumentOperationBudget = {
      maxInputBytes: 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
      maxDepth: 128,
      maxElements: 100_000,
      timeoutMs: 1_000,
    }
    const write = (value: unknown) =>
      richText.prepareWrite!({
        bytes: new TextEncoder().encode(JSON.stringify(value)),
        sourceVersion: 1,
        budget,
        signal: new AbortController().signal,
      })

    // Every rich-text Doc the repository ships, as written and as the editor
    // saves it, and the shapes agents and earlier versions wrote.
    const fixtureDocs: unknown[] = []
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (/\/spaces\/[^/]+\/docs\/.+\.json$/.test(path)) {
          fixtureDocs.push(JSON.parse(readFileSync(path, "utf8")))
        }
      }
    }
    visit(resolve(import.meta.dir, "../../../fixtures/workspaces"))
    expect(fixtureDocs.length).toBeGreaterThan(0)
    const gettingStarted = await buildWhatAgentsCanMakeBlocks()
    // What a Markdown import, a conversion and an agent's Markdown write make.
    const imported = await markdownToBlocks(
      [
        "# One", "## Two", "### Three", "#### Four", "##### Five", "###### Six",
        "Text with **bold**, *italic*, ~~strike~~, `code` and [a link](https://example.com).",
        "- bullet", "  - nested", "1. first", "2. second", "5. from five",
        "- [ ] open", "- [x] done", "> quoted", "---",
        "```ts\nconst a = 1\n```", "```mermaid\ngraph TD\nA-->B\n```",
        "| A | B |\n| :-- | --: |\n| 1 | 2 |",
        "![alt](https://example.com/a.png)",
      ].join("\n\n")
    )
    // Every block type the editor knows, with every prop it has, as it saves.
    const everyType = Object.entries(
      serverSchema.blockSchema as Record<
        string,
        { content: string; propSchema: Record<string, { default?: unknown }> }
      >
    ).map(([type, config]) => ({
      type,
      props: Object.fromEntries(
        Object.entries(config.propSchema).map(([key, spec]) => [
          key,
          spec.default ?? (key === "level" ? 2 : ""),
        ])
      ),
      ...(config.content === "inline" || config.content === "plain"
        ? { content: "words" }
        : config.content === "table"
          ? { content: { type: "tableContent", rows: [{ cells: ["A", "B"] }] } }
          : {}),
    }))
    const docs: unknown[] = [
      ...fixtureDocs,
      gettingStarted,
      await canonicalizeBlocks(gettingStarted),
      imported,
      await canonicalizeBlocks(imported),
      everyType,
      await canonicalizeBlocks(everyType),
      // Props earlier Worktables wrote, which today's schema doesn't give.
      [
        {
          type: "codeBlock",
          props: {
            language: "ts",
            backgroundColor: "default",
            textColor: "default",
            textAlignment: "left",
          },
          content: "const a = 1",
        },
        {
          type: "table",
          props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
          content: { type: "tableContent", rows: [{ cells: ["A"] }] },
        },
        { type: "mermaid", props: { code: "graph TD", language: "mermaid" } },
      ],
      [],
      [{ type: "paragraph" }],
      [{ type: "paragraph", content: "Plain words" }],
      [{ type: "paragraph", content: [{ text: "Untyped text" }] }],
      [
        {
          type: "bulletListItem",
          props: { textColor: "default" },
          content: [
            { type: "link", href: "https://example.com", content: "a link" },
          ],
          children: [{ type: "checkListItem", props: { checked: true } }],
        },
      ],
      [
        {
          type: "table",
          content: {
            type: "tableContent",
            columnWidths: [null, 120],
            rows: [
              { cells: [[{ type: "text", text: "A", styles: {} }], "B"] },
              { cells: [{ type: "tableCell", content: "C" }] },
            ],
          },
        },
      ],
      [{ type: "mermaid", props: { code: "graph TD" }, content: [] }],
      [{ type: "image", props: { url: "https://example.com/a.png" } }],
    ]
    for (const doc of docs) {
      await expect(write(doc)).resolves.toBeDefined()
    }
    expect(everyType.length).toBe(
      Object.keys(serverSchema.blockSchema).length
    )

    // A field the editor would drop on its next save is refused by name.
    await expect(
      write([
        {
          type: "bulletListItem",
          props: { textColor: "default", extraFromNewerVersion: "dropped" },
          content: "words",
        },
      ])
    ).rejects.toThrow("Unknown field `extraFromNewerVersion` on bulletListItem")
    await expect(
      write([
        {
          type: "table",
          content: {
            type: "tableContent",
            rows: [{ cells: [{ type: "tableCell", props: { tint: "red" }, content: "A" }] }],
          },
        },
      ])
    ).rejects.toThrow("Unknown field `tint` on a table cell")

    // An agent's data, configuration and anything else is not a Doc.
    for (const data of [
      [{ id: 1, name: "a" }, { id: 2, name: "b" }],
      { name: "package", version: "1.0.0" },
      [1, 2, 3],
      ["a", "b"],
      [{ type: "user", name: "Ada" }],
      [{ type: "paragraph", text: "a field the editor would drop" }],
      [{ type: "paragraph", props: { nested: { value: 1 } } }],
      [{ type: "paragraph", content: [{ type: "mention", user: "x" }] }],
      [{ type: "image", content: [{ type: "text", text: "x" }] }],
      [{ type: "paragraph", children: [{ id: 3 }] }],
    ]) {
      await expect(write(data)).rejects.toThrow(
        "Rich-text source must contain Doc blocks"
      )
    }
  })
})
