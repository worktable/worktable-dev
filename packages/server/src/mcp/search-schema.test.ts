import { describe, expect, it } from "bun:test";
import { SearchInput } from "./schemas.ts";

describe("SearchInput", () => {
  it("parses docs-only search input", () => {
    const parsed = SearchInput.parse({ query: "lorena" });
    expect(parsed.query).toBe("lorena");
    expect("searchBlocks" in parsed).toBe(false);
  });
});
