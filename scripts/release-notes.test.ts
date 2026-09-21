import { describe, expect, it } from "bun:test";
import { extractNotes } from "./release-notes.ts";

const CHANGELOG = `# Changelog

## [Unreleased]

<!-- placeholder guidance that must never be published -->

### Added
- Pending feature not yet released

## [0.0.4] - 2026-06-18

### Added
- One-click releases from the Actions tab

### Fixed
- Setup no longer stalls on a missing config

## [0.0.3] - 2026-06-17

- Early releases predate this changelog.
`;

describe("extractNotes", () => {
  it("returns the section for an exact version", () => {
    const notes = extractNotes(CHANGELOG, "0.0.4");
    expect(notes).toContain("One-click releases from the Actions tab");
    expect(notes).toContain("Setup no longer stalls");
    // Stops at the next version heading.
    expect(notes).not.toContain("Early releases predate");
    // Does not bleed in the Unreleased section above it.
    expect(notes).not.toContain("Pending feature");
  });

  it("accepts a v-prefixed tag", () => {
    expect(extractNotes(CHANGELOG, "v0.0.4")).toContain("One-click releases");
  });

  it("falls back to Unreleased when the version is absent", () => {
    const notes = extractNotes(CHANGELOG, "9.9.9");
    expect(notes).toContain("Pending feature not yet released");
  });

  it("strips HTML comments from the body", () => {
    const notes = extractNotes(CHANGELOG, "9.9.9");
    expect(notes).not.toContain("placeholder guidance");
  });

  it("returns empty string when nothing usable exists", () => {
    expect(extractNotes("# Changelog\n\nNo sections here.\n", "1.2.3")).toBe("");
  });
});
