import { describe, expect, it } from "bun:test";
import { LinkGrantSchema, type RecordCollectionSchema, type WidgetFile } from "@worktable/types";
import { validateLinkGrant } from "./link-grant.ts";
import { suggestLinkGrant } from "./link-grant-suggest.ts";
import { buildRecordCollectionSchema } from "./record-store.ts";

const schemas = new Map<string, RecordCollectionSchema>(
  Object.entries({
    deals: {
      name: { type: "text" },
      amount: { type: "number" },
      stage: { type: "select", values: ["lead", "won"] },
      region: { type: "select", values: ["eu", "us"] },
      client: { type: "relation", references: "clients" },
      owner: { type: "person" },
      notes: { type: "text" },
    },
    clients: { name: { type: "text" }, email: { type: "email" } },
    orders: { region: { type: "select", values: ["eu", "us"] }, channel: { type: "select", values: ["web", "shop"] }, amount: { type: "number" }, owner: { type: "person" } },
    contacts: {
      name: { type: "text" },
      phone: { type: "text" },
      email: { type: "email" },
      owner: { type: "person" },
      profile: { type: "json" },
      page: { type: "document" },
      company: { type: "relation", references: "clients" },
      vault: { type: "relation", references: "secrets" },
      kind: { type: "text" },
    },
    notes: { body: { type: "text" } },
    archive: { body: { type: "text" } },
    secrets: { code: { type: "text" } },
  }).map(([id, fields]) => [id, buildRecordCollectionSchema({ id, name: id[0]!.toUpperCase() + id.slice(1), fields: fields as never })]),
);

// A small dashboard: two deal lists, totals of orders, every contact, notes
// after a click, and a collection it picks as it runs.
const HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><button id="more" type="button">More</button><script>
const won = worktable.records.query("deals", { where: { region: "eu", stage: "won" }, select: ["name", "amount", "client"], orderBy: "amount", expand: { client: ["name"] } });
const open = worktable.records.query("deals", { where: { and: [{ field: "region", op: "eq", value: "eu" }, { field: "stage", op: "eq", value: "lead" }] }, select: ["name"] });
const totals = worktable.records.queryDetailed("orders", { where: { region: "eu" }, aggregate: { groupBy: "channel", select: { n: { fn: "count" }, total: { fn: "sum", field: "amount" } } } });
const people = worktable.records.query("contacts");
document.querySelector("#more").addEventListener("click", () => worktable.records.query("notes", {}));
const pick = (kind) => worktable.records.query(\`\${kind}s\`, {});
pick("secret");
</script></body></html>`;

// What a preview saw on first load, repeats included.
const OBSERVED = [
  { collectionId: "deals", query: { where: { region: "eu", stage: "won" }, select: ["name", "amount", "client"], orderBy: "amount", expand: { client: ["name"] } } },
  { collectionId: "deals", query: { where: { and: [{ field: "region", op: "eq", value: "eu" }, { field: "stage", op: "eq", value: "lead" }] }, select: ["name"] } },
  { collectionId: "deals", query: { select: ["client", "amount", "name"], where: { stage: "won", region: "eu" }, orderBy: [{ field: "amount" }], expand: { client: ["name"] } } },
  { collectionId: "orders", query: { where: { region: "eu" }, aggregate: { groupBy: "channel", select: { n: { fn: "count" }, total: { fn: "sum", field: "amount" } } } } },
  { collectionId: "contacts", query: {} },
  // Refused: the tool may not read what these reach.
  { collectionId: "contacts", query: { select: ["name"], expand: { vault: true } } },
  { collectionId: "secrets", query: {} },
];

const PERMISSIONS: WidgetFile["permissions"] = {
  network: false,
  state: { read: true, write: true },
  records: Object.fromEntries(["deals", "clients", "orders", "contacts", "notes", "archive"].map((id) => [id, { read: true }])),
};

describe("suggestLinkGrant", () => {
  it("suggests the least a tool's first load needs, and says what it may have missed", () => {
    const suggestion = suggestLinkGrant({ permissions: PERMISSIONS, html: HTML, observed: OBSERVED, schemas });
    const scoped = { rows: null, timestamps: true, mode: "scoped" } as const;
    expect(suggestion.grant.collections).toEqual({
      // Reached through an expand, so its rows show.
      clients: { ...scoped, fields: ["name"] },
      // Read whole: everything but people, email, documents, JSON and names
      // records use for themselves.
      contacts: { ...scoped, fields: ["company", "name", "phone"] },
      // Every field a read names, and the condition every read shares.
      deals: { ...scoped, rows: { field: "region", op: "eq", value: "eu" }, fields: ["amount", "client", "name", "region", "stage"] },
      // Named in the HTML but only read after a click.
      notes: { ...scoped, fields: [] },
      // Only ever asked for totals.
      orders: {
        rows: { field: "region", op: "eq", value: "eu" },
        fields: [],
        timestamps: true,
        mode: "summaries",
        summaries: { groupBy: ["channel", "region"], measures: ["amount"], fns: ["count", "sum"], minGroupSize: 5 },
      },
    });
    expect(suggestion.warnings.map((warning) => [warning.code, warning.collectionId])).toEqual([
      ["dynamic_collection", undefined],
      ["whole_records", "contacts"],
      ["static_only", "notes"],
      ["declared_unseen", "archive"],
    ]);
    expect(validateLinkGrant(suggestion.grant, schemas)).toEqual([]);

    // The reads it saw, once each, can be saved as they are. Refused reads
    // read nothing, so they aren't among them.
    expect(suggestion.fixedReads.deals!.map((read) => read.id)).toEqual(["read-1", "read-2"]);
    expect(suggestion.fixedReads.contacts!.map((read) => read.query)).toEqual([{}]);
    const fixed = LinkGrantSchema.parse({
      ...suggestion.grant,
      collections: { ...suggestion.grant.collections, deals: { ...suggestion.grant.collections.deals, mode: "fixed", fixed: suggestion.fixedReads.deals } },
    });
    expect(validateLinkGrant(fixed, schemas)).toEqual([]);

    // Reading every collection never suggests all of them.
    const everything = suggestLinkGrant({ permissions: { ...PERMISSIONS, records: { "*": { read: true } } }, html: HTML, observed: OBSERVED, schemas });
    expect(Object.keys(everything.grant.collections)).toEqual(["clients", "contacts", "deals", "notes", "orders", "secrets"]);

    // More reads or fields than a link can hold are kept to its limits, and said so.
    const wide = buildRecordCollectionSchema({ id: "wide", fields: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, { type: "text" }])) });
    const busy = suggestLinkGrant({
      permissions: { ...PERMISSIONS, records: { ...PERMISSIONS.records, wide: { read: true } } },
      html: "",
      observed: [...Array.from({ length: 51 }, (_, i) => ({ collectionId: "notes", query: { where: { body: `note ${i}` } } })), { collectionId: "wide", query: {} }],
      schemas: new Map([...schemas, ["wide", wide]]),
    });
    expect(busy.fixedReads.notes).toHaveLength(50);
    expect(busy.grant.collections.wide!.fields).toHaveLength(200);
    expect(busy.warnings.map((warning) => [warning.code, warning.collectionId])).toEqual(expect.arrayContaining([["too_many_reads", "notes"], ["too_many_fields", "wide"]]));
  });
});
