import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, truncate, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  getDocAliasesPath,
} from "./workspace.ts";
import {
  docAliasReservationError,
  DOC_ALIASES_MAX_BYTES,
  prepareDocAliasBatch,
  prepareDocAliasPrefixRetirement,
  readDocAliases,
  recordDocAlias,
  recordDocAliasBatch,
  resolveDocAlias,
  resolveDocAliasIn,
  retireDocAlias,
  type DocAliases,
} from "./doc-aliases.ts";
import {
  deleteDoc,
  docExists,
  listDocs,
  renameDoc,
  writeDoc,
  writeSpace,
} from "./store.ts";
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts";
import { onWorkspaceChange } from "./workspace-events.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-aliases-"));
  setWorkspaceRootOverride(root);
});

afterEach(async () => {
  setWorkspaceRootOverride(null);
  await rm(root, { recursive: true, force: true });
});

describe("document aliases", () => {
  it("prefers exact aliases over the longest matching prefix", () => {
    const aliases: DocAliases = {
      exact: { "old/special": "exact-target" },
      prefixes: { old: "new", "old/nested": "deep" },
    };
    expect(resolveDocAliasIn(aliases, "old/special")).toBe("exact-target");
    expect(resolveDocAliasIn(aliases, "old/nested/doc")).toBe("deep/doc");
    expect(resolveDocAliasIn(aliases, "old/other")).toBe("new/other");
  });

  it("compacts chains when a document is renamed repeatedly", async () => {
    await recordDocAlias("space", "a", "b", "exact");
    await recordDocAlias("space", "b", "c", "exact");

    expect((await resolveDocAlias("space", "a")).path).toBe("c");
    expect((await resolveDocAlias("space", "b")).path).toBe("c");
    const stored = await readDocAliases("space");
    expect(stored.aliases?.exact).toEqual({ a: "c", b: "c" });
    expect(
      resolveDocAliasIn(
        {
          exact: { "Legacy/Movable": "Current", current: "final" },
          prefixes: {},
        },
        "legacy/movable"
      )
    ).toBe("final");
  });

  it("rejects cycles and leaves the last valid portable state intact", async () => {
    await recordDocAlias("space", "a", "b", "exact");
    await expect(recordDocAlias("space", "b", "a", "exact")).rejects.toThrow(
      "cycle"
    );
    expect((await readDocAliases("space")).aliases?.exact).toEqual({ a: "b" });
  });

  it("serializes concurrent alias updates without losing either rename", async () => {
    await Promise.all([
      recordDocAlias("space", "a", "b", "exact"),
      recordDocAlias("space", "c", "d", "exact"),
    ]);
    expect((await readDocAliases("space")).aliases?.exact).toEqual({
      a: "b",
      c: "d",
    });
  });

  it("treats prototype-shaped document names as ordinary alias keys", async () => {
    const prepared = JSON.parse(
      prepareDocAliasBatch(
        {
          exact: Object.create(null) as Record<string, string>,
          prefixes: Object.create(null) as Record<string, string>,
        },
        [{ from: "__proto__", to: "prepared", kind: "exact" }]
      )
    ) as DocAliases;
    expect(resolveDocAliasIn(prepared, "__proto__")).toBe("prepared");

    await recordDocAlias("space", "__proto__", "current", "exact");
    expect((await resolveDocAlias("space", "__proto__")).path).toBe("current");
    expect((await readDocAliases("space")).aliases?.exact["__proto__"]).toBe(
      "current"
    );
  });

  it("uses one prefix alias for a moved folder and retargets older aliases", async () => {
    await recordDocAlias("space", "legacy", "plans", "prefix");
    await recordDocAlias("space", "plans", "archive", "prefix");

    expect((await resolveDocAlias("space", "legacy/q3/doc")).path).toBe(
      "archive/q3/doc"
    );
    expect((await resolveDocAlias("space", "plans/q4")).path).toBe("archive/q4");
    expect(
      resolveDocAliasIn(
        {
          exact: {},
          prefixes: {
            "Legacy/Folder": "Current",
            Current: "archive",
          },
        },
        "Legacy/Folder/Child"
      )
    ).toBe("archive/Child");
    expect(
      resolveDocAliasIn(
        {
          exact: {},
          prefixes: { "Legacy/Folder": "Current" },
        },
        "legacy/folder/child"
      )
    ).toBe("legacy/folder/child");
  });

  it("does not let an exact alias at a prefix target retarget its children", async () => {
    await recordDocAlias("space", "new", "final", "exact");
    await recordDocAlias("space", "old", "new", "prefix");

    expect((await resolveDocAlias("space", "old/child")).path).toBe("new/child");
    expect((await readDocAliases("space")).aliases?.prefixes).toEqual({
      old: "new",
    });
  });

  it("preserves descendant exact aliases when an intermediate folder moves", async () => {
    await recordDocAlias("space", "folder", "archive", "prefix");
    await recordDocAlias("space", "archive/target", "final", "exact");
    await recordDocAlias("space", "archive", "new-archive", "prefix");

    expect((await resolveDocAlias("space", "folder/target")).path).toBe("final");
    expect((await resolveDocAlias("space", "folder/other")).path).toBe(
      "new-archive/other"
    );
    expect((await readDocAliases("space")).aliases?.prefixes).toEqual({
      folder: "archive",
      archive: "new-archive",
    });
  });

  it("applies a prefix alias only once when a folder moves into an ancestor", async () => {
    await recordDocAlias("space", "a/b", "a", "prefix");

    expect((await resolveDocAlias("space", "a/b/b/c")).path).toBe("a/b/c");
  });

  it("continues through a shorter prefix after an ancestor rewrite", async () => {
    const aliases: DocAliases = {
      exact: {},
      prefixes: { "a/b": "a", a: "x" },
    };

    expect(resolveDocAliasIn(aliases, "a/b/b/c")).toBe("x/b/c");
  });

  it("reserves exact aliases and every path under a prefix alias", async () => {
    await recordDocAlias("space", "old-doc", "new-doc", "exact");
    await recordDocAlias("space", "old-folder", "new-folder", "prefix");

    expect(await docAliasReservationError("space", "old-doc")).toContain("exact");
    expect(await docAliasReservationError("space", "old-folder/child")).toContain(
      "prefix"
    );
    expect(await docAliasReservationError("space", "OLD-FOLDER/Child")).toContain(
      "prefix"
    );
    expect(await docAliasReservationError("space", "available")).toBeNull();
  });

  it("retires only aliases whose resolved destination belongs to a deleted folder", () => {
    const aliases: DocAliases = {
      exact: {
        "legacy-doc": "intermediate-doc",
        "intermediate-doc": "folder/doc",
        "folder/old-spelling": "elsewhere/doc",
        outside: "elsewhere/other",
      },
      prefixes: {
        "legacy-folder": "folder",
        "folder/old-prefix": "elsewhere/archive",
        unrelated: "elsewhere/current",
      },
    };

    const prepared = prepareDocAliasPrefixRetirement(aliases, "folder");
    expect(prepared).not.toBeNull();
    const retired = JSON.parse(prepared!) as DocAliases;
    expect(retired.exact).toEqual({
      "folder/old-spelling": "elsewhere/doc",
      outside: "elsewhere/other",
    });
    expect(retired.prefixes).toEqual({
      "folder/old-prefix": "elsewhere/archive",
      unrelated: "elsewhere/current",
    });

    expect(() =>
      prepareDocAliasPrefixRetirement(
        { exact: {}, prefixes: { legacy: "root" } },
        "root/folder"
      )
    ).toThrow("broader folder alias");
  });

  it("fails closed on corrupt or comparison-ambiguous portable state", async () => {
    const path = getDocAliasesPath("space");
    await recordDocAlias("space", "old", "current", "exact");
    expect((await resolveDocAlias("space", "old")).path).toBe("current");

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not-json", "utf8");

    expect((await resolveDocAlias("space", "old")).path).toBeNull();
    expect(await docAliasReservationError("space", "anything")).toContain("Corrupt");

    for (const kind of ["exact", "prefixes"] as const) {
      await writeFile(
        path,
        JSON.stringify({
          type: "worktable.doc-aliases",
          version: 1,
          exact:
            kind === "exact"
              ? { Legacy: "first", legacy: "second" }
              : {},
          prefixes:
            kind === "prefixes"
              ? { "Legacy/Folder": "first", "legacy/folder": "second" }
              : {},
        }),
        "utf8"
      );

      expect(
        (
          await resolveDocAlias(
            "space",
            kind === "exact" ? "legacy" : "legacy/folder/child"
          )
        ).path
      ).toBeNull();
    }

    await writeFile(
      path,
      JSON.stringify({
        type: "worktable.doc-aliases",
        version: 1,
        exact: { repaired: "current" },
        prefixes: {},
      }),
      "utf8"
    );
    expect((await resolveDocAlias("space", "repaired")).path).toBe("current");
  });

  it("rejects oversized alias metadata before parsing it", async () => {
    const path = getDocAliasesPath("space");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
    await truncate(path, DOC_ALIASES_MAX_BYTES + 1);

    const result = await readDocAliases("space");

    expect(result.aliases).toBeNull();
    expect(result.error).toContain("exceeds its size limit");
  });

  it("refuses to replace readable aliases with an oversized write", async () => {
    await recordDocAlias("space", "old", "new", "exact");
    const oversizedPath = "x".repeat(DOC_ALIASES_MAX_BYTES);

    await expect(
      recordDocAliasBatch("space", [
        { from: oversizedPath, to: "target", kind: "exact" },
      ])
    ).rejects.toThrow("exceeds its size limit");

    expect((await readDocAliases("space")).aliases?.exact).toEqual({
      old: "new",
    });
  });

  it("fails closed on a synced prefix cycle that contains an ancestor move", async () => {
    const path = getDocAliasesPath("space");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        type: "worktable.doc-aliases",
        version: 1,
        exact: {},
        prefixes: { "a/b": "a", a: "a/b" },
      }),
      "utf8"
    );

    const result = await resolveDocAlias("space", "a/b/b/c");
    expect(result.path).toBeNull();
    expect(result.error).toContain("cycle or hop limit");
  });

  it("rejects a synced prefix alias whose target is its own descendant", async () => {
    const path = getDocAliasesPath("space");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        type: "worktable.doc-aliases",
        version: 1,
        exact: {},
        prefixes: { a: "a/b" },
      }),
      "utf8"
    );

    expect((await readDocAliases("space")).aliases).toBeNull();
    expect((await resolveDocAlias("space", "a/child")).error).toContain(
      "cycle or hop limit"
    );
  });

  it("rejects a synced prefix cycle that depends on a child suffix", async () => {
    const path = getDocAliasesPath("space");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        type: "worktable.doc-aliases",
        version: 1,
        exact: {},
        prefixes: { a: "b", "b/a": "a" },
      }),
      "utf8"
    );

    expect((await readDocAliases("space")).aliases).toBeNull();
    expect((await resolveDocAlias("space", "a/a")).error).toContain(
      "cycle or hop limit"
    );
  });

  it("rejects a synced cycle reached through a target plus real suffix", async () => {
    const path = getDocAliasesPath("space");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        type: "worktable.doc-aliases",
        version: 1,
        exact: {},
        prefixes: { a: "b/c", "a/b": "b", "b/b": "a/b" },
      }),
      "utf8"
    );

    expect((await readDocAliases("space")).aliases).toBeNull();
    expect((await resolveDocAlias("space", "b/b/b")).error).toContain(
      "cycle or hop limit"
    );
  });

  it("publishes internal alias writes through the workspace event seam", async () => {
    const events: unknown[] = [];
    const off = onWorkspaceChange((event) => events.push(event));
    try {
      await recordDocAlias("space", "old", "new", "exact");
    } finally {
      off();
    }

    expect(events).toContainEqual({ type: "docAliases", spaceId: "space" });
  });

  it("requires explicit retirement before an alias path is reusable", async () => {
    await writeDoc("space", "current", "# Current");
    await recordDocAlias("space", "old", "current", "exact");

    const blockedWrite = await writeDoc("space", "old", "# Replacement");
    expect(blockedWrite.ok).toBe(false);
    expect(blockedWrite.error).toContain("reserved");
    expect((await renameDoc("space", "current", "old")).error).toContain(
      "reserved"
    );

    expect(await retireDocAlias("space", "old", "exact")).toBe(true);
    expect(await docAliasReservationError("space", "old")).toBeNull();
    expect((await writeDoc("space", "old", "# Replacement")).ok).toBe(true);
    expect(await docExists("space", "old")).toBe(true);
  });

  it("blocks writes when an external sync recreates a reserved old path", async () => {
    await recordDocAlias("space", "old", "current", "exact");
    const externalPath = join(root, "spaces", "space", "docs", "old.md");
    await mkdir(dirname(externalPath), { recursive: true });
    await writeFile(externalPath, "# External copy\n", "utf8");

    const result = await writeDoc("space", "old", "# API overwrite\n");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("reserved");
    expect(await readFile(externalPath, "utf8")).toBe("# External copy\n");
    expect(await listDocs("space")).toEqual([]);
    expect((await renameDoc("space", "old", "replacement")).error).toContain(
      "reserved"
    );
    expect((await deleteDoc("space", "old")).error).toContain("reserved");
    expect(await readFile(externalPath, "utf8")).toBe("# External copy\n");
    expect((await resolveDocAlias("space", "old")).path).toBe("current");
  });

  it("keeps a durable Doc when a folder alias cannot represent its deletion", async () => {
    ensureWorkspaceManifest();
    const now = new Date().toISOString();
    await writeSpace({
      type: "worktable.space",
      version: 1,
      id: "space",
      name: "Space",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: { docOrder: ["final"] },
    });
    await writeDoc("space", "final", "# Durable\n");
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "final",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/final.md" },
        },
      ],
    });
    await recordDocAlias("space", "current/doc", "final", "exact");
    await recordDocAlias("space", "old-folder", "current", "prefix");

    const deleted = await deleteDoc("space", "final");

    expect(deleted.error).toContain("folder alias");
    expect((await resolveDocAlias("space", "old-folder/doc")).path).toBe(
      "final"
    );
    expect(await docExists("space", "final")).toBe(true);
  });
});
