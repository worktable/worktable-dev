import { afterEach, describe, expect, it, mock } from "bun:test";
import { docMarkdownFilename, resolveDocumentReferences } from "./docs-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("docMarkdownFilename", () => {
  it("uses the last path segment as the slug", () => {
    expect(docMarkdownFilename("specs/storage-contract")).toBe("storage-contract.md");
  });

  it("handles single-segment paths", () => {
    expect(docMarkdownFilename("notes")).toBe("notes.md");
  });

  it("ignores empty segments from stray slashes", () => {
    expect(docMarkdownFilename("folder//doc/")).toBe("doc.md");
  });

  it("falls back for an empty path", () => {
    expect(docMarkdownFilename("")).toBe("doc.md");
  });
});

describe("resolveDocumentReferences", () => {
  it("chunks requests to the server's 500-path contract and preserves order", async () => {
    const batches: string[][] = [];
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const paths = (JSON.parse(String(init?.body)) as { paths: string[] }).paths;
      batches.push(paths);
      return Response.json({
        references: paths.map((path) => ({
          storedPath: path,
          resolvedPath: path,
          title: path,
          state: "available",
        })),
      });
    }) as typeof fetch;

    const paths = Array.from({ length: 1_001 }, (_, index) => `doc-${index}`);
    const references = await resolveDocumentReferences("meta", paths);

    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 1]);
    expect(references.map((reference) => reference.storedPath)).toEqual(paths);
  });
});
