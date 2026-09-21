import { describe, expect, it } from "bun:test";

import { validateMermaid } from "./mermaid.ts";

describe("mermaid MCP helpers", () => {
  it("validates valid Mermaid", async () => {
    const result = await validateMermaid("flowchart TD\nA-->B");
    expect(result.ok).toBe(true);
    expect(result.diagramType).toBe("flowchart-v2");
  });

  it("returns parse errors for invalid Mermaid", async () => {
    const result = await validateMermaid("flowchart TD\nA-->");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

});
