import { describe, expect, it } from "bun:test";
import { parseCanonicalYaml, stringifyCanonicalYaml } from "./yaml.ts";

describe("canonical YAML key order", () => {
  it("preserves authored order only for a record schema's top-level fields", () => {
    const schema = {
      version: 2,
      kind: "worktable.recordSchema",
      id: "research",
      name: "Research",
      fields: {
        summary: { type: "text" },
        title: { type: "string" },
      },
    };

    const parsed = parseCanonicalYaml(stringifyCanonicalYaml(schema)) as typeof schema;
    expect(Object.keys(parsed.fields)).toEqual(["summary", "title"]);
  });

  it("sorts a nested user data object named fields", () => {
    const record = {
      version: 1,
      kind: "worktable.record",
      data: {
        fields: { zeta: 1, alpha: 2 },
      },
    };

    const parsed = parseCanonicalYaml(stringifyCanonicalYaml(record)) as typeof record;
    expect(Object.keys(parsed.data.fields)).toEqual(["alpha", "zeta"]);
  });
});
