import { describe, expect, it } from "bun:test"
import {
  FILE_SURFACE_NOTES,
  FILE_SURFACE_RULES,
  FILE_TYPE_NOTES,
} from "./file-type-notes"
import {
  FILE_TYPES,
  UNKNOWN_FILE_POLICIES,
  fileMediaTypesWhere,
  fileTypeFor,
  type FileSurface,
  type FileSurfacePolicies,
  type FileTypeEntry,
  type FileTypeId,
} from "./file-types"

// Every value each surface's policy can take. Typed per surface, so a new
// surface or value fails to compile until it is listed here too.
const POLICY_VALUES: {
  readonly [S in FileSurface]: readonly FileSurfacePolicies[S][]
} = {
  serve: ["inline", "download", "bytes"],
  page: ["image", "table", "text", "card"],
  icon: ["image", "spreadsheet", "document", "code", "audio", "video", "archive", "file"],
  agent: ["image", "text", "bytes"],
  share: ["inline", "placeholder"],
  drawing: [true, false],
  paste: [true, false],
  import: [true, false],
  diff: [true, false],
}

const SURFACES = Object.keys(UNKNOWN_FILE_POLICIES) as FileSurface[]
const TYPES = Object.entries(FILE_TYPES) as [FileTypeId, FileTypeEntry][]

describe("the file type table", () => {
  it("gives every type a policy on every surface, and every surface a default", () => {
    expect(SURFACES.sort()).toEqual(
      (Object.keys(POLICY_VALUES) as FileSurface[]).sort()
    )
    expect((Object.keys(FILE_SURFACE_NOTES) as FileSurface[]).sort()).toEqual(SURFACES)
    for (const surface of SURFACES) {
      expect(POLICY_VALUES[surface] as readonly unknown[]).toContain(
        UNKNOWN_FILE_POLICIES[surface]
      )
      expect(FILE_SURFACE_NOTES[surface].where.length).toBeGreaterThan(0)
    }
    for (const [id, entry] of TYPES) {
      for (const surface of SURFACES) {
        expect(
          POLICY_VALUES[surface] as readonly unknown[],
          `${id} on ${surface}`
        ).toContain(entry.surfaces[surface])
      }
    }
  })

  it("names each extension and base name once, and finds each type by it", () => {
    const seen = new Map<string, FileTypeId>()
    for (const [id, entry] of TYPES) {
      const keys = [
        ...entry.extensions.map((extension) => `.${extension}`),
        ...(entry.names ?? []),
      ]
      expect(keys.length, id).toBeGreaterThan(0)
      for (const key of keys) {
        expect(key, id).toMatch(/^\.?[a-z0-9]+$/)
        expect(seen.get(key), key).toBeUndefined()
        seen.set(key, id)
        const name = key.startsWith(".") ? `report${key}` : key
        expect(fileTypeFor(name)).toBe(id)
        expect(fileTypeFor(`a/b.c/${name.toUpperCase()}`)).toBe(id)
      }
      expect(entry.mediaType, id).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/)
    }
  })

  it("decides by the base name under one case rule", () => {
    expect(fileTypeFor("archive.tar.gz")).toBe("gzip")
    expect(fileTypeFor("Photo.JPG")).toBe("jpeg")
    expect(fileTypeFor("Dockerfile")).toBe("dockerfile")
    expect(fileTypeFor("a.csv/notes")).toBeNull()
    expect(fileTypeFor("notes")).toBeNull()
    expect(fileTypeFor("notes.")).toBeNull()
    expect(fileTypeFor("script.py")).toBeNull()
    // A hidden name holds no file, so it has no type.
    expect(fileTypeFor(".png")).toBeNull()
    expect(fileTypeFor("docs/.csv")).toBeNull()
    // Only ASCII letters fold: look-alikes never stand for them.
    expect(fileTypeFor("clip.mKv")).toBeNull()
    expect(fileTypeFor("data.cſv")).toBeNull()
    expect(fileTypeFor("data.csv".normalize("NFD"))).toBe("csv")
  })

  it("records why wherever surfaces disagree, and nowhere else", () => {
    for (const [id, entry] of TYPES) {
      const notes = FILE_TYPE_NOTES[id]
      const broken = new Set<FileSurface>()
      for (const rule of FILE_SURFACE_RULES) {
        if (rule.holds(entry.surfaces, entry)) continue
        const noted = rule.surfaces.filter((surface) => notes?.[surface])
        expect(noted, `${id} breaks "${rule.name}" without a note`).not.toEqual([])
        for (const surface of rule.surfaces) broken.add(surface)
      }
      for (const [surface, note] of Object.entries(notes ?? {})) {
        expect(broken.has(surface as FileSurface), `${id}: stale note on ${surface}`).toBe(
          true
        )
        expect(note.why.length, `${id}: ${surface}`).toBeGreaterThan(0)
      }
    }
  })

  it("keeps the shared-page images the Cloud gateway accepts", () => {
    // The Cloud gateway enforces this same set, so it changes only with it.
    expect(fileMediaTypesWhere("share", "inline")).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ])
  })
})
