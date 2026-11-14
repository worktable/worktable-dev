import { describe, expect, it } from "bun:test"
import type { LibraryEntry, LibraryRef } from "./library"
import {
  changeOf,
  placesOf,
  recentOf,
  removedOf,
  skillsIn,
  pendingOf,
} from "./library-view"
import { parseLibraryPath } from "./library-path"

const WORKTABLE: LibraryRef = { kind: "worktable" }
const OPS: LibraryRef = { kind: "space", spaceId: "ops" }
const HELPER: LibraryRef = { kind: "agent", participantId: "helper" }
const HIRING: LibraryRef = { kind: "space", spaceId: "hiring" }

let made = 0
function skill(
  title: string,
  library: LibraryRef,
  change: Partial<LibraryEntry> = {}
): LibraryEntry {
  made += 1
  return {
    id: `skl_${made}`,
    name: title.toLowerCase().replace(/\s+/g, "-"),
    description: `When doing ${title.toLowerCase()}.`,
    library,
    doc: { spaceId: "ops", documentId: `doc_${made}` },
    live: { generationId: `gen_${made}`, savedAt: "2026-01-01", savedBy: "a" },
    proposal: null,
    removed: null,
    revision: 1,
    libraryLabel: "",
    ...(library.kind === "space" ? { libraryName: "Ops" } : {}),
    ...(library.kind === "agent" ? { libraryName: "Helper" } : {}),
    docPath: title,
    docTitle: title,
    draft: false,
    mayChange: true,
    ...change,
  }
}

const proposal = (
  kind: "add" | "update" | "remove",
  at: string
): LibraryEntry["proposal"] => ({
  kind,
  at,
  by: { participantId: "helper", displayName: "Helper" },
})

const titles = (entries: LibraryEntry[]) =>
  entries.map((entry) => entry.docTitle)

describe("what the Library shows", () => {
  const entries = [
    skill("Naming", WORKTABLE, {
      live: { generationId: "g1", savedAt: "2026-03-01", savedBy: "a" },
    }),
    skill("House Style", WORKTABLE, { draft: true }),
    skill("Release", OPS, { proposal: proposal("update", "2026-03-02") }),
    skill("Handover", OPS, {
      live: null,
      proposal: proposal("add", "2026-03-03"),
    }),
    skill("Old Runbook", OPS, { removed: { at: "2026-02-01", by: "a" } }),
    skill("Commits", HELPER),
    skill("Offers", HIRING, { libraryName: "Hiring" }),
  ]

  it("reads where it is from its address", () => {
    expect(parseLibraryPath("")).toEqual({ kind: "home" })
    expect(parseLibraryPath("pending")).toEqual({
      kind: "view",
      view: "pending",
    })
    expect(parseLibraryPath("space:ops/skl_1")).toEqual({
      kind: "library",
      key: "space:ops",
      skillId: "skl_1",
    })
    expect(parseLibraryPath("worktable")).toEqual({
      kind: "library",
      key: "worktable",
      skillId: undefined,
    })
    // Links from elsewhere name a skill alone.
    expect(parseLibraryPath("skl_1")).toEqual({
      kind: "skill",
      skillId: "skl_1",
    })
  })

  it("lists only libraries with skills, the Worktable's first", () => {
    const { places, pending, removed } = placesOf(entries)
    expect(places.map((place) => [place.key, place.count])).toEqual([
      ["worktable", 2],
      ["space:hiring", 1],
      ["space:ops", 2],
      ["agent:helper", 1],
    ])
    expect([pending, removed]).toEqual([3, 1])
  })

  it("holds a library's skills by title, proposed ones too", () => {
    expect(titles(skillsIn(entries, "space:ops"))).toEqual([
      "Handover",
      "Release",
    ])
  })

  it("puts agents' proposals first, newest first, then drafts", () => {
    expect(titles(pendingOf(entries))).toEqual([
      "Handover",
      "Release",
      "House Style",
    ])
    expect(titles(removedOf(entries))).toEqual(["Old Runbook"])
  })

  it("names the skills saved last", () => {
    expect(titles(recentOf(entries, 1))).toEqual(["Naming"])
    // A skill only proposed has never been saved.
    expect(titles(recentOf(entries, 10))).not.toContain("Handover")
  })
})

describe("what a change does to a skill's text", () => {
  const LIVE = "# Release\n\nTag the build.\nRun the smoke test.\n"
  const NEXT = "# Release\n\nTag the build.\nRun the smoke test twice.\n\n"
  const shown = (
    entry: Pick<LibraryEntry, "proposal">,
    texts: Parameters<typeof changeOf>[1]
  ) =>
    changeOf(entry, texts)?.flatMap((part) =>
      part.lines.map(
        (line) => `${part.kind === "fold" ? "~" : ""}${line.kind}:${line.text}`
      )
    )

  it("marks dropped and new lines, without the heading that repeats the title", () => {
    const texts = { live: LIVE, next: NEXT }
    expect(shown({ proposal: proposal("update", "1") }, texts)).toEqual([
      "same:Tag the build.",
      "removed:Run the smoke test.",
      "added:Run the smoke test twice.",
    ])
    // A person's draft compares the same way.
    expect(shown({ proposal: null }, texts)).toEqual(
      shown({ proposal: proposal("update", "1") }, texts)
    )
  })

  it("folds long unchanged stretches", () => {
    const steps = Array.from({ length: 12 }, (_, n) => `Step ${n}`)
    const next = [...steps.slice(0, 11), "Step 11, twice"].join("\n")
    const parts = changeOf(
      { proposal: null },
      { live: steps.join("\n"), next }
    )!
    expect(parts.map((part) => part.kind)).toEqual(["fold", "lines"])
  })

  it("strikes a removal, and marks a new skill's text all new", () => {
    expect(
      shown({ proposal: proposal("remove", "1") }, { live: LIVE })
    ).toEqual(["removed:Tag the build.", "removed:Run the smoke test."])
    expect(
      shown({ proposal: proposal("add", "1") }, { live: null, next: NEXT })
    ).toEqual(["added:Tag the build.", "added:Run the smoke test twice."])
  })

  it("has nothing to show for a text that can't be read", () => {
    expect(changeOf({ proposal: null }, { live: null })).toBeNull()
    // A draft of a skill whose live text is lost has nothing to compare with.
    expect(changeOf({ proposal: null }, { live: null, next: NEXT })).toBeNull()
    expect(
      changeOf(
        { proposal: proposal("update", "1") },
        { live: LIVE, next: null }
      )
    ).toBeNull()
  })
})
