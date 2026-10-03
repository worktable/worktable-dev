import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_MERMAID_SOURCE, type SpaceFile } from "@worktable/types"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import {
  extractMarkdownMermaid,
  prepareDocumentContent,
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
    const result = (await dispatchOperation("docs.write", { lifetime: "durable",
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
    const failure = dispatchOperation("docs.write", { lifetime: "durable",
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
    const result = (await dispatchOperation("docs.write", { lifetime: "durable",
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

  it("normalizes legacy Mermaid code blocks to the custom block", async () => {
    await dispatchOperation("docs.write", { lifetime: "durable",
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
    await dispatchOperation("docs.write", { lifetime: "durable",
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
      dispatchOperation("docs.write", { lifetime: "durable",
        spaceId,
        docPath: "explicit-empty-source",
        content: [{ type: "mermaid", props: { data: "" } }],
      })
    ).rejects.toBeInstanceOf(MermaidDocumentValidationError)
  })

  it("rejects a present non-string Mermaid source instead of defaulting it", async () => {
    await expect(
      dispatchOperation("docs.write", { lifetime: "durable",
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
    const result = (await dispatchOperation("docs.write", { lifetime: "durable",
      spaceId,
      docPath: "unterminated-code-sample",
      content,
    })) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect((await readDoc(spaceId, "unterminated-code-sample")).data).toBe(
      content
    )
  })

  it("rejects an invalid edit without changing the existing document", async () => {
    await dispatchOperation("docs.write", { lifetime: "durable",
      spaceId,
      docPath: "edit-target",
      content: "# Stable\n",
    })

    await expect(
      dispatchOperation("docs.edit", {
        spaceId,
        docPath: "edit-target",
        edits: [
          {
            oldText: "# Stable\n",
            newText: "# Stable\n\n```mermaid\nflowchart TD\nA-->\n```\n",
          },
        ],
      })
    ).rejects.toBeInstanceOf(MermaidDocumentValidationError)

    expect((await readDoc(spaceId, "edit-target")).data).toBe("# Stable\n")
  })

  it("keeps escaped Mermaid examples verbatim while editing unrelated content", async () => {
    const source =
      "# Mermaid syntax\n\n\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\n"
    writeFileSync(
      join(testDir, "spaces", spaceId, "docs", "literal-edit.md"),
      source
    )

    await dispatchOperation("docs.edit", {
      spaceId,
      docPath: "literal-edit",
      edits: [{ oldText: "# Mermaid syntax", newText: "# Mermaid syntax notes" }],
    })

    expect((await readDoc(spaceId, "literal-edit")).data).toBe(
      source.replace("# Mermaid syntax", "# Mermaid syntax notes")
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

  it("rejects an unpaired escaped fence in edit text", async () => {
    await dispatchOperation("docs.write", { lifetime: "durable",
      spaceId,
      docPath: "unpaired-edit-target",
      content: "# Stable\n",
    })

    await expect(
      dispatchOperation("docs.edit", {
        spaceId,
        docPath: "unpaired-edit-target",
        edits: [
          {
            oldText: "# Stable\n",
            newText: "# Stable\n\n\\`\\`\\`mermaid\nflowchart TD\nA-->B\n",
          },
        ],
      })
    ).rejects.toBeInstanceOf(MermaidDocumentValidationError)

    expect((await readDoc(spaceId, "unpaired-edit-target")).data).toBe(
      "# Stable\n"
    )
  })

  it("repairs escaped fences in edit text and reports the repair", async () => {
    await dispatchOperation("docs.write", { lifetime: "durable",
      spaceId,
      docPath: "repaired-edit-target",
      content: "# Stable\n",
    })

    const result = (await dispatchOperation("docs.edit", {
      spaceId,
      docPath: "repaired-edit-target",
      edits: [
        {
          oldText: "# Stable\n",
          newText: "\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\n",
        },
      ],
    })) as {
      repairs: Array<{ code: string; startLine: number; endLine: number }>
    }

    expect(result.repairs).toEqual([
      expect.objectContaining({
        code: "ESCAPED_MERMAID_FENCE_REPAIRED",
        editIndex: 0,
        startLine: 1,
        endLine: 4,
      }),
    ])
    expect((await readDoc(spaceId, "repaired-edit-target")).data).toBe(
      "```mermaid\nflowchart TD\nA-->B\n```\n"
    )
  })
})

// Grammar variants share the actual parser; MCP write/edit atomicity is above.
describe("Mermaid fence grammar", () => {
  it("validates and repairs fenced diagrams in Markdown containers", async () => {
    for (const { prefix, prelude, marker, language, startLine } of [
      {
        prefix: "> ",
        prelude: "",
        marker: "```",
        language: "mermaid",
        startLine: 1,
      },
      {
        prefix: "    ",
        prelude: "- Outer item\n  - Inner item\n",
        marker: "```",
        language: "mmd",
        startLine: 3,
      },
      { prefix: "", prelude: "", marker: "~~~", language: "mmd", startLine: 1 },
    ]) {
      const content = `${prelude}${prefix}${marker}${language}\n${prefix}flowchart TD\n${prefix}A-->B\n${prefix}${marker}\n`
      const escaped = content.replaceAll(
        marker,
        [...marker].map((char) => `\\${char}`).join(""),
      )
      const result = await prepareDocumentContent(escaped, {
        validation: "strict",
      })
      expect(result.content).toBe(content)
      expect(result.repairs).toEqual([
        expect.objectContaining({ code: "ESCAPED_MERMAID_FENCE_REPAIRED" }),
      ])
      await expect(
        prepareDocumentContent(content.replace("A-->B", "A-->"), {
          validation: "strict",
        }),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            code: "INVALID_MERMAID",
            startLine,
            endLine: startLine + 3,
          }),
        ],
      })
    }
  })
})
