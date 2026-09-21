import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildProvenanceManifest } from "./manifest-provenance.ts"

function srcDir(manifest?: object): string {
  const d = mkdtempSync(join(tmpdir(), "wt-src-"))
  if (manifest)
    writeFileSync(join(d, "worktable.workspace.json"), JSON.stringify(manifest))
  return d
}

describe("buildProvenanceManifest", () => {
  test("mints a fresh id, preserves name/createdAt, stamps sandbox provenance", () => {
    const d = srcDir({
      type: "worktable.workspace",
      version: 1,
      id: "ws_source",
      name: "Alex Daily",
      createdAt: "2025-01-01T00:00:00.000Z",
      cloud: { status: "unlinked" },
    })
    try {
      const m = buildProvenanceManifest(d, {
        mode: "sandbox",
        label: "Daily",
        path: "/home/example/Worktable",
      }) as Record<string, any>
      expect(m["id"]).toMatch(/^ws_[A-Za-z0-9_-]+$/)
      expect(m["id"]).not.toBe("ws_source") // fresh id so id-keyed state never bleeds
      expect(m["name"]).toBe("Alex Daily") // preserved from source
      expect(m["createdAt"]).toBe("2025-01-01T00:00:00.000Z")
      expect(m["provenance"].mode).toBe("sandbox")
      expect(m["provenance"].source.workspaceId).toBe("ws_source")
      expect(m["provenance"].source.label).toBe("Daily")
      expect(m["provenance"].source.path).toBe("/home/example/Worktable")
      expect(m["provenance"].oneWay).toBe(true)
      expect(m["provenance"].disposable).toBe(true)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  test("falls back gracefully when the source manifest is missing", () => {
    const d = srcDir()
    try {
      const m = buildProvenanceManifest(d, { mode: "sandbox" }) as Record<
        string,
        any
      >
      expect(m["id"]).toMatch(/^ws_/)
      expect(m["name"]).toBe("Workspace")
      expect(m["provenance"].mode).toBe("sandbox")
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  test("fixture mode is not disposable and carries fixtureName", () => {
    const d = srcDir()
    try {
      const m = buildProvenanceManifest(d, {
        mode: "fixture",
        fixtureName: "engineer",
      }) as Record<string, any>
      expect(m["provenance"].mode).toBe("fixture")
      expect(m["provenance"].disposable).toBe(false)
      expect(m["provenance"].fixtureName).toBe("engineer")
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
