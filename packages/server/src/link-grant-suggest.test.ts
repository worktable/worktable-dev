import { describe, expect, it } from "bun:test";
import type { RecordCollectionSchema, WidgetFile } from "@worktable/types";
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
      brief: { type: "document" },
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
  { collectionId: "deals", query: { where: { and: [{ field: "region", op: "eq", value: "eu" }, { field: "stage", op: "eq", value: "lead" }] }, select: ["name", "brief"] } },
  { collectionId: "deals", query: { select: ["client", "amount", "name"], where: { stage: "won", region: "eu" }, orderBy: [{ field: "amount" }], expand: { client: ["name"] } } },
  { collectionId: "orders", query: { where: { region: "eu" }, includeArchived: true, aggregate: { groupBy: "channel", select: { n: { fn: "count" }, total: { fn: "sum", field: "amount" } } } } },
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
  it("warns about omitted search fields and later reads of an observed collection", () => {
    const suggestion = suggestLinkGrant({
      permissions: PERMISSIONS,
      html: 'worktable.records.query("deals", { select: ["name"] }); button.onclick = () => worktable.records.query("deals", { select: ["amount"] });',
      observed: [
        { collectionId: "deals", query: { search: "private note", select: ["name"] } },
        { collectionId: "deals", query: { search: "x".repeat(201), aggregate: { select: { n: { fn: "count" } } } } },
      ],
      schemas,
    });
    expect(suggestion.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["search_fields", "later_reads", "long_search"]));
    expect(suggestion.grant.collections.deals!.fields).toEqual(["name"]);
  });
  it("warns about stale explicit fields", () => {
    const suggestion = suggestLinkGrant({
      permissions: PERMISSIONS,
      html: "",
      observed: [
        { collectionId: "deals", query: { select: ["name", "id", "createdAt", "updatedAt"], orderBy: "removed" } },
      ],
      schemas,
    });
    const omitted = suggestion.warnings.find((warning) => warning.code === "fields_left_out")!;
    expect(omitted.message).toContain('"removed"');
    for (const name of ["id", "createdAt", "updatedAt"]) expect(omitted.message).not.toContain(`"${name}"`);
  });
  it("suggests the least a tool's first load needs, and says what it may have missed", () => {
    const suggestion = suggestLinkGrant({ permissions: PERMISSIONS, html: HTML, observed: OBSERVED, schemas });
    const scoped = { rows: null, timestamps: true } as const;
    expect(suggestion.grant.collections).toEqual({
      // Reached through an expand, so its rows show.
      clients: { ...scoped, fields: ["name"] },
      // Read whole: everything but people, email, documents, JSON and names
      // records use for themselves.
      contacts: { ...scoped, fields: ["company", "name", "phone"] },
      // Every field a read names, on every record: a condition every read
      // shares doesn't narrow the link.
      deals: { ...scoped, fields: ["amount", "client", "name", "region", "stage"] },
      // Named in the HTML but only read after a click.
      notes: { ...scoped, fields: [] },
      // Totals read their groupings and measures.
      orders: { ...scoped, fields: ["amount", "channel", "region"] },
    });
    expect(suggestion.warnings.map((warning) => [warning.code, warning.collectionId])).toEqual([
      ["dynamic_collection", undefined],
      ["later_reads", "contacts"],
      ["whole_records", "contacts"],
      ["later_reads", "deals"],
      ["fields_left_out", "deals"],
      ["static_only", "notes"],
      ["later_reads", "orders"],
      ["archived_rows", "orders"],
      ["declared_unseen", "archive"],
    ]);
    expect(validateLinkGrant(suggestion.grant, schemas)).toEqual([]);

    // Reading every collection never suggests all of them.
    const everything = suggestLinkGrant({ permissions: { ...PERMISSIONS, records: { "*": { read: true } } }, html: HTML, observed: OBSERVED, schemas });
    expect(Object.keys(everything.grant.collections)).toEqual(["clients", "contacts", "deals", "notes", "orders", "secrets"]);

    // More fields than a link can hold are kept to its limit, and said so.
    const wide = buildRecordCollectionSchema({ id: "wide", fields: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, { type: "text" }])) });
    const busy = suggestLinkGrant({
      permissions: { ...PERMISSIONS, records: { ...PERMISSIONS.records, wide: { read: true } } },
      html: "",
      observed: [{ collectionId: "wide", query: {} }],
      schemas: new Map([...schemas, ["wide", wide]]),
    });
    expect(busy.grant.collections.wide!.fields).toHaveLength(200);
    expect(busy.warnings.map((warning) => [warning.code, warning.collectionId])).toEqual(expect.arrayContaining([["too_many_fields", "wide"]]));
  });
});
