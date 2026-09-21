import { readFileSync } from "node:fs";
import { join } from "node:path";

// Extracts the release-notes body for a version from a Keep a Changelog document.
// Prefers the section for the exact version (e.g. "## [0.0.3] - 2026-06-17");
// falls back to the "## [Unreleased]" section when the version has not been
// promoted yet (e.g. a plain tag push). HTML comments (placeholder guidance) are
// stripped so they never reach published notes. Returns "" when nothing usable
// is found — the workflow substitutes a generic body in that case.
export function extractNotes(changelog: string, version: string): string {
  const v = version.replace(/^v/, "");
  return section(changelog, `[${v}]`) || section(changelog, "[Unreleased]");
}

function section(changelog: string, heading: string): string {
  const lines = changelog.split("\n");
  const start = lines.findIndex(
    (line) => line.startsWith("## ") && line.slice(3).trimStart().startsWith(heading)
  );
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: release-notes.ts <version|tag>");
    process.exit(1);
  }
  const root = new URL("..", import.meta.url).pathname;
  let changelog = "";
  try {
    changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  } catch {
    // No changelog yet — emit nothing and let the caller fall back.
  }
  process.stdout.write(extractNotes(changelog, version));
}
