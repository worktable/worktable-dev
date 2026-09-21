import { describe, expect, it } from "bun:test"
import type { DocumentFormatId, DocumentTextProjection } from "@worktable/types"
import {
  BUILTIN_DOCUMENT_FORMATS,
  DOCUMENT_RENDER_DISPOSITIONS,
  DocumentFormatRegistry,
  createBuiltinDocumentFormatRegistry,
  type DocumentOperationBudget,
} from "./document-format-registry.ts"

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
    ])
    expect(registry.extensions()).toEqual([".canvas"])
    expect(registry.forFilename("PLAN.CANVAS")?.id).toBe("future.canvas")
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
})
