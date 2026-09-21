import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_MERMAID_SOURCE, type SpaceFile } from "@worktable/types"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import {
  extractMarkdownMermaid,
  MermaidDocumentValidationError,
} from "./mermaid-document.ts"
import { getDocPath, readDoc, writeSpace } from "./store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

const testDir = join(tmpdir(), `worktable-mermaid-document-${Date.now()}`)
const spaceId = "mermaid-pipeline"

function makeSpace(): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Mermaid Pipeline",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

describe("automatic Mermaid document pipeline", () => {
  beforeEach(async () => {
    mkdirSync(testDir, { recursive: true })
    setWorkspaceRootOverride(testDir)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace())
  })

  afterEach(() => {
    setWorkspaceRootOverride(null)
    rmSync(testDir, { recursive: true, force: true })
  })

  it("accepts valid markdown Mermaid without a separate validation call", async () => {
    const result = (await dispatchOperation("docs.write", {
      spaceId,
      docPath: "valid-markdown",
      content: "# Flow\n\n```mermaid\nflowchart TD\nA-->B\n```\n",
    })) as { ok: boolean; storedAs: string }

    expect(result.ok).toBe(true)
    expect(result.storedAs).toBe("md")
  }, 15_000)

  it("does not classify escaped literal syntax as an embedded diagram", () => {
    expect(
      extractMarkdownMermaid(
        "\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\n"
      )
    ).toEqual([])
  })

  it("rejects an invalid agent write atomically with diagram location", async () => {
    const failure = dispatchOperation("docs.write", {
      spaceId,
      docPath: "invalid-new",
      content: "# Broken\n\n```mermaid\nflowchart TD\nA-->\n```\n",
    })

    await expect(failure).rejects.toBeInstanceOf(MermaidDocumentValidationError)
    await failure.catch((error: MermaidDocumentValidationError) => {
      expect(error.issues[0]).toMatchObject({
        code: "INVALID_MERMAID",
        representation: "markdown-fence",
        diagramIndex: 1,
        startLine: 3,
        endLine: 6,
      })
    })
    expect(existsSync(getDocPath(spaceId, "invalid-new"))).toBe(false)
  })

  it("repairs paired escaped fences before validation and storage", async () => {
    const result = (await dispatchOperation("docs.write", {
      spaceId,
      docPath: "escaped-fence",
      content: "# Flow\n\n\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\n",
    })) as {
      repairs: Array<{
        code: string
        diagramIndex: number
        startLine: number
        endLine: number
      }>
    }

    expect(result.repairs).toEqual([
      {
        code: "ESCAPED_MERMAID_FENCE_REPAIRED",
        diagramIndex: 1,
        startLine: 3,
        endLine: 6,
      },
    ])
    const stored = await readDoc(spaceId, "escaped-fence")
    expect(stored.data).toContain("```mermaid")
    expect(stored.data).not.toContain("\\`")
  })

  it("validates Mermaid fences nested in a Markdown blockquote", async () => {
    const failure = dispatchOperation("docs.write", {
      spaceId,
      docPath: "invalid-blockquote",
      content: "> ```mermaid\n> flowchart TD\n> A-->\n> ```\n",
    })

    await expect(failure).rejects.toBeInstanceOf(MermaidDocumentValidationError)
    await failure.catch((error: MermaidDocumentValidationError) => {
      expect(error.issues[0]).toMatchObject({
        code: "INVALID_MERMAID",
        representation: "markdown-fence",
        diagramIndex: 1,
        startLine: 1,
        endLine: 4,
      })
    })
    expect(existsSync(getDocPath(spaceId, "invalid-blockquote"))).toBe(false)
  })

  it("repairs escaped Mermaid fences nested in a Markdown blockquote", async () => {
    await dispatchOperation("docs.write", {
      spaceId,
      docPath: "escaped-blockquote",
      content: "> \\`\\`\\`mermaid\n> flowchart TD\n> A-->B\n> \\`\\`\\`\n",
    })

    const stored = await readDoc(spaceId, "escaped-blockquote")
    expect(stored.data).toContain("> ```mermaid")
    expect(stored.data).toContain("> flowchart TD")
    expect(stored.data).not.toContain("\\`")
  })

  it("validates Mermaid fences nested in list containers", async () => {
    const failure = dispatchOperation("docs.write", {
      spaceId,
      docPath: "invalid-list-diagram",
      content:
        "- Outer item\n  - Inner item\n    ```mermaid\n    flowchart TD\n    A-->\n    ```\n",
    })

    await expect(failure).rejects.toBeInstanceOf(MermaidDocumentValidationError)
    await failure.catch((error: MermaidDocumentValidationError) => {
      expect(error.issues[0]).toMatchObject({
        code: "INVALID_MERMAID",
        startLine: 3,
        endLine: 6,
      })
    })
  })

  it("repairs escaped Mermaid fences nested in list containers", async () => {
    await dispatchOperation("docs.write", {
      spaceId,
      docPath: "escaped-list-diagram",
      content:
        "- Outer item\n  - Inner item\n    \\`\\`\\`mmd\n    flowchart TD\n    A-->B\n    \\`\\`\\`\n",
    })

    const stored = await readDoc(spaceId, "escaped-list-diagram")
    expect(stored.data).toContain("    ```mmd")
    expect(stored.data).not.toContain("\\`")
  })

  it("repairs escaped tilde Mermaid fences", async () => {
    await dispatchOperation("docs.write", {
      spaceId,
      docPath: "escaped-tilde-fence",
      content: "\\~\\~\\~mmd\nflowchart TD\nA-->B\n\\~\\~\\~\n",
    })

    const stored = await readDoc(spaceId, "escaped-tilde-fence")
    expect(stored.data).toContain("~~~mmd")
    expect(stored.data).not.toContain("\\~")
  })

  it("normalizes legacy Mermaid code blocks to the custom block", async () => {
    await dispatchOperation("docs.write", {
      spaceId,
      docPath: "legacy-json",
      content: [
        {
          id: "diagram",
          type: "codeBlock",
          props: { language: "mmd" },
          content: [{ type: "text", text: "flowchart TD\nA-->B", styles: {} }],
          children: [],
        },
      ],
    })

    const stored = await readDoc(spaceId, "legacy-json")
    expect(stored.data).toEqual([
      expect.objectContaining({
        id: "diagram",
        type: "mermaid",
        props: expect.objectContaining({ data: "flowchart TD\nA-->B" }),
      }),
    ])
  })

  it("applies the default source only when custom block data is omitted", async () => {
    await dispatchOperation("docs.write", {
      spaceId,
      docPath: "default-source",
      content: [{ type: "mermaid" }],
    })

    const stored = await readDoc(spaceId, "default-source")
    expect(stored.data).toEqual([
      expect.objectContaining({
        type: "mermaid",
        props: expect.objectContaining({ data: DEFAULT_MERMAID_SOURCE }),
      }),
    ])

    await expect(
      dispatchOperation("docs.write", {
        spaceId,
        docPath: "explicit-empty-source",
        content: [{ type: "mermaid", props: { data: "" } }],
      })
    ).rejects.toBeInstanceOf(MermaidDocumentValidationError)
  })

  it("rejects a present non-string Mermaid source instead of defaulting it", async () => {
    await expect(
      dispatchOperation("docs.write", {
        spaceId,
        docPath: "malformed-source",
        content: [
          {
            type: "mermaid",
            props: { data: 123 },
            children: [],
          },
        ],
      })
    ).rejects.toBeInstanceOf(MermaidDocumentValidationError)
    expect(existsSync(getDocPath(spaceId, "malformed-source"))).toBe(false)
  })

  it("does not validate literal Mermaid text inside an unmatched code fence", async () => {
    const content = "````text\n```mermaid\nflowchart TD\nA-->\n```\n"
    const result = (await dispatchOperation("docs.write", {
      spaceId,
      docPath: "unterminated-code-sample",
      content,
    })) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect((await readDoc(spaceId, "unterminated-code-sample")).data).toBe(
      content
    )
  })

  it("rejects an invalid patch without changing the existing document", async () => {
    await dispatchOperation("docs.write", {
      spaceId,
      docPath: "patch-target",
      content: "# Stable\n",
    })

    await expect(
      dispatchOperation("docs.patch", {
        spaceId,
        docPath: "patch-target",
        operations: [
          {
            action: "append",
            content: "```mermaid\nflowchart TD\nA-->\n```",
          },
        ],
      })
    ).rejects.toBeInstanceOf(MermaidDocumentValidationError)

    expect((await readDoc(spaceId, "patch-target")).data).toBe("# Stable\n")
  })

  it("preserves escaped Mermaid examples while patching unrelated content", async () => {
    const source =
      "# Mermaid syntax\n\n\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\n"
    writeFileSync(
      join(testDir, "spaces", spaceId, "docs", "literal-patch.md"),
      source
    )

    await dispatchOperation("docs.patch", {
      spaceId,
      docPath: "literal-patch",
      operations: [{ action: "append", content: "## Added\n\nUnrelated." }],
    })

    const stored = await readDoc(spaceId, "literal-patch")
    expect(stored.data).toContain("\\`\\`\\`mermaid")
    expect(stored.data).toContain("## Added")
  })

  it("does not resurrect a protected escaped example when its quote is deleted", async () => {
    const source =
      "> Delete this quote\n>\n> \\`\\`\\`mermaid\n> flowchart TD\n> A-->B\n> \\`\\`\\`\n\n# Keep\n"
    writeFileSync(
      join(testDir, "spaces", spaceId, "docs", "literal-quote.md"),
      source
    )

    await dispatchOperation("docs.patch", {
      spaceId,
      docPath: "literal-quote",
      operations: [
        { action: "delete", target: { search: "Delete this quote" } },
      ],
    })

    const stored = await readDoc(spaceId, "literal-quote")
    expect(stored.data).not.toContain("mermaid")
    expect(stored.data).not.toContain("WorktableEscapedMermaidPlaceholder")
    expect(stored.data).toContain("# Keep")
  })

  it("restores escaped Mermaid examples when a patch upgrades Markdown to rich JSON", async () => {
    const source =
      "# Mermaid syntax\n\n\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\n"
    writeFileSync(
      join(testDir, "spaces", spaceId, "docs", "literal-upgrade.md"),
      source
    )

    const result = (await dispatchOperation("docs.patch", {
      spaceId,
      docPath: "literal-upgrade",
      operations: [
        {
          action: "append",
          content: [
            {
              type: "mermaid",
              props: {
                data: "flowchart TD\nNew-->Diagram",
                title: "Named diagram",
              },
              children: [],
            },
          ],
        },
      ],
    })) as { storedAs: string }

    expect(result.storedAs).toBe("json")
    const stored = await readDoc(spaceId, "literal-upgrade")
    expect(JSON.stringify(stored.data)).toContain("```mermaid")
    expect(JSON.stringify(stored.data)).not.toContain(
      "WorktableEscapedMermaidPlaceholder"
    )
  })

  it("restores an embedded escaped placeholder during a rich JSON upgrade", async () => {
    const source =
      "Before\n\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\nAfter\n"
    writeFileSync(
      join(testDir, "spaces", spaceId, "docs", "embedded-upgrade.md"),
      source
    )

    await dispatchOperation("docs.patch", {
      spaceId,
      docPath: "embedded-upgrade",
      operations: [
        {
          action: "append",
          content: [
            {
              type: "mermaid",
              props: {
                data: "flowchart TD\nNew-->Diagram",
                title: "Named diagram",
              },
              children: [],
            },
          ],
        },
      ],
    })

    const stored = await readDoc(spaceId, "embedded-upgrade")
    const literalText = (stored.data as Array<any>)[0].content[0].text
    expect(literalText).toContain("\\`\\`\\`mermaid")
    expect(JSON.stringify(stored.data)).not.toContain(
      "WorktableEscapedMermaidPlaceholder"
    )
  })

  it("does not validate Mermaid content in a skipped patch operation", async () => {
    await dispatchOperation("docs.write", {
      spaceId,
      docPath: "skipped-patch-target",
      content: "# Stable\n",
    })

    const result = (await dispatchOperation("docs.patch", {
      spaceId,
      docPath: "skipped-patch-target",
      operations: [
        {
          action: "replace",
          target: { heading: "Missing" },
          content: "```mermaid\nflowchart TD\nA-->\n```",
        },
        { action: "append", content: "## Applied\n" },
      ],
    })) as {
      operationsApplied: number
      skipped: Array<{ index: number; reason: string }>
    }

    expect(result.operationsApplied).toBe(1)
    expect(result.skipped).toEqual([
      expect.objectContaining({
        index: 0,
        reason: 'target not found: heading="Missing"',
      }),
    ])
    expect((await readDoc(spaceId, "skipped-patch-target")).data).toContain(
      "## Applied"
    )
  })

  it("keeps Mermaid helpers callable for HTML docs and existing clients", async () => {
    const validation = (await dispatchOperation("mermaid.validate", {
      source: "flowchart TD\nA-->B",
    })) as { ok: boolean }
    const preview = (await dispatchOperation("mermaid.preview", {
      source: "flowchart TD\nA-->B",
      theme: "light",
    })) as { ok: boolean; svg?: string }

    expect(validation.ok).toBe(true)
    expect(preview.ok).toBe(true)
    expect(preview.svg).toContain("<svg")

    const guide = (await dispatchOperation("html.guide", {
      profile: "runtime",
    })) as { guide: string }
    expect(guide.guide).toContain("worktable_mermaid")
    expect(guide.guide).toContain('action "preview"')
  })

  it("rejects an unpaired escaped fence inside a patch operation", async () => {
    await dispatchOperation("docs.write", {
      spaceId,
      docPath: "unpaired-patch-target",
      content: "# Stable\n",
    })

    await expect(
      dispatchOperation("docs.patch", {
        spaceId,
        docPath: "unpaired-patch-target",
        operations: [
          {
            action: "append",
            content: "\\`\\`\\`mermaid\nflowchart TD\nA-->B\n",
          },
        ],
      })
    ).rejects.toBeInstanceOf(MermaidDocumentValidationError)

    expect((await readDoc(spaceId, "unpaired-patch-target")).data).toBe(
      "# Stable\n"
    )
  })

  it("returns repairs collected from patch operation content", async () => {
    await dispatchOperation("docs.write", {
      spaceId,
      docPath: "repaired-patch-target",
      content: "# Stable\n",
    })

    const result = (await dispatchOperation("docs.patch", {
      spaceId,
      docPath: "repaired-patch-target",
      operations: [
        {
          action: "append",
          content: "\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\n",
        },
      ],
    })) as {
      repairs: Array<{ code: string; startLine: number; endLine: number }>
    }

    expect(result.repairs).toEqual([
      expect.objectContaining({
        code: "ESCAPED_MERMAID_FENCE_REPAIRED",
        startLine: 1,
        endLine: 4,
      }),
    ])
  })
})
