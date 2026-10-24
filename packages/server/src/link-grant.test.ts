import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalIdSchema, LinkGrantSchema, type LinkGrant, type RecordFile } from "@worktable/types";
import { setAppDirOverride } from "./app-storage.ts";
import { readLinkGrantSchemas, validateLinkGrant } from "./link-grant.ts";
import { createLinkKey, linkQueryFailure, openLinkReadView, type LinkKey } from "./link-grant-view.ts";
import { recordIndex } from "./record-index.ts";
import { buildRecordCollectionSchema, queryRecords, writeRecord, writeRecordCollectionSchema } from "./record-store.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";

// ---- Two workspaces that differ only in what the grant hides -------------
//
// "a" and "b" hold the same visible rows: same granted values, same shown
// times, relations to the same visible rows. Everything else differs: hidden
// fields, hidden and archived rows, the envelope (format version, createdBy,
// metadata, unknown top-level keys), unshown times, and every stored id, which in "a" is a slug
// of the title. A link query that answers differently in the two leaks.
// Orders hide their times, which differ too, and their stored ids run in
// opposite orders, so totals that added rows in stored order would differ in
// their last digit.

const SCHEMAS = {
  deals: {
    name: { type: "text" },
    stage: { type: "select", values: ["lead", "won", "lost"] },
    amount: { type: "number" },
    client: { type: "relation", references: "clients" },
    region: { type: "select", values: ["eu", "us"] },
    notes: { type: "text" },
    margin: { type: "number" },
    partner: { type: "relation", references: "clients" },
    contract: { type: "json" },
  },
  clients: { name: { type: "text" }, tier: { type: "select", values: ["public", "private"] }, secret: { type: "text" } },
  activities: { title: { type: "text" }, deal: { type: "relation", references: "deals" }, kind: { type: "select", values: ["call", "private"] }, body: { type: "text" } },
  vault: { name: { type: "text" } },
  orders: {
    title: { type: "text" },
    region: { type: "select", values: ["eu", "us"] },
    channel: { type: "select", values: ["web", "shop"] },
    tags: { type: "multi_select", values: ["new", "vip"] },
    amount: { type: "number" },
    cost: { type: "number" },
    status: { type: "select", values: ["open", "paid", "void"] },
    owner: { type: "person" },
    deal: { type: "relation", references: "deals" },
  },
  tasks: {
    title: { type: "text" },
    status: { type: "select", values: ["open", "done", "private"] },
    deal: { type: "relation", references: "deals" },
    effort: { type: "number" },
    secret: { type: "text" },
    field: { type: "text" },
    op: { type: "text" },
    owner: { type: "person" },
  },
} as const;

const GRANT: LinkGrant = LinkGrantSchema.parse({
  version: 1,
  collections: {
    deals: { rows: { field: "region", op: "eq", value: "eu" }, fields: ["name", "stage", "amount", "client"] },
    clients: { rows: { field: "tier", op: "eq", value: "public" }, fields: ["name"], timestamps: false },
    activities: { rows: { field: "kind", op: "eq", value: "call" }, fields: ["title", "deal"] },
    orders: { rows: { field: "status", op: "neq", value: "void" }, fields: ["region", "channel", "tags", "amount"], timestamps: false },
    tasks: { rows: { field: "status", op: "in", value: ["done", "open"] }, fields: ["title", "status", "deal", "effort"] },
  },
  limits: { rowsPerQuery: 2 },
});

// The (region, channel, amount) of every visible order, the same in both
// workspaces. "us" holds the smallest amount, and the "eu" sum changes in its
// last digit with the order its amounts are added in.
const ORDERS: [string, string, number][] = [
  ["eu", "web", 0.1], ["eu", "web", 0.2], ["eu", "web", 0.3], ["eu", "web", 0.4], ["eu", "shop", 0.7], ["eu", "shop", 1.1],
  ["us", "web", 0.05], ["us", "web", 2], ["us", "web", 4], ["us", "web", 5], ["us", "shop", 3],
];

// Totals of the orders the grant shows. Hidden fields can't group, measure
// or filter them.
const COUNT = { n: { fn: "count" } };
const TOTALS = { n: { fn: "count" }, total: { fn: "sum", field: "amount" }, mean: { fn: "avg", field: "amount" } };
const ANY_TOTAL = { aggregate: { select: COUNT } };
const ORDER_PROBES: Record<string, unknown>[] = [
  { aggregate: { select: TOTALS } },
  { aggregate: { groupBy: "region", select: TOTALS } },
  { aggregate: { groupBy: "channel", select: COUNT } },
  { aggregate: { groupBy: "region", select: {} } },
  { where: { region: "eu" }, aggregate: { groupBy: "channel", select: TOTALS } },
  { where: { field: "channel", op: "eq", value: "shop" }, aggregate: { select: COUNT } },
  { where: { and: [{ field: "region", op: "in", value: ["eu", "us"] }, { channel: "web" }] }, aggregate: { select: TOTALS } },
  { includeArchived: true, aggregate: { groupBy: "channel", select: TOTALS } },
  { where: { field: "tags", op: "has", value: "new" }, aggregate: { select: TOTALS } },
  { aggregate: { groupBy: "tags", select: COUNT } },
  ...["min", "max", "unique"].map((fn) => ({ aggregate: { select: { x: { fn, field: "amount" } } } })),
  ...["status", "title", "cost", "owner", "deal", "id", "createdAt", "createdBy", "nonexistent"].flatMap((name) => [
    { aggregate: { groupBy: name, select: COUNT } },
    { aggregate: { select: { x: { fn: "sum", field: name } } } },
    { ...ANY_TOTAL, where: { field: name, op: "eq", value: "x" } },
  ]),
  { ...ANY_TOTAL, where: { field: "deal.name", op: "eq", value: "Renewal" } },
];

// Task reads as a board sends them: a flat filter, a plain sort and fields
// in any order. Others filter on hidden fields, on fields named "field" and
// "op", and search text that also sits in a hidden field and on a hidden row.
const boardAsk = (status: unknown) => ({ where: { status, effort: { gte: 1 } }, orderBy: "title", select: ["title", "status", "deal"] });
const TASK_PROBES: Record<string, unknown>[] = [
  boardAsk("open"),
  boardAsk("done"),
  boardAsk("private"),
  { ...boardAsk("open"), includeArchived: true, limit: 50 },
  { ...boardAsk("open"), orderBy: "effort" },
  ...["title", "secret", "nonexistent"].map((field) => ({ ...boardAsk("open"), where: { status: "open", effort: { gte: 1 }, [field]: "Chase" } })),
  { where: { field: "x", op: "open" } },
  { where: { status: "open", owner: "alice" }, orderBy: "title" },
  { where: { deal: "lr-deal-2" }, select: ["title"] },
  { where: { deal: "lr-deal-1" }, expand: { deal: ["name"] } },
  { search: "brief" },
  { search: "brief", orderBy: [{ field: "effort", dir: "desc" }] },
  {},
];

interface Seed {
  collection: keyof typeof SCHEMAS;
  id: string;
  label?: string;
  data: Record<string, unknown>;
  times?: string;
  envelope?: Record<string, unknown>;
}

const T1 = "2026-10-01T09:00:00.000Z";
const T2 = "2026-10-02T09:00:00.000Z";

function variant(v: "a" | "b"): Seed[] {
  const a = v === "a";
  const id = (slug: string, opaque: string) => (a ? slug : opaque);
  const client = id("acme", "c-1");
  const hiddenClient = id("secret-co", "c-9");
  const [d1, d2, d3] = [id("renewal", "d-1"), id("pilot", "d-2"), id("expansion", "d-3")];
  const hiddenDeal = id("megadeal", "d-9");
  const envelope = a
    ? { version: 2, createdBy: "member:alice", updatedBy: "member:alice", metadata: { source: "crm" }, extraTop: "leak" }
    : { createdBy: "agent:bot", metadata: {} };
  return [
    { collection: "clients", id: client, label: "lr-client-1", data: { name: "Acme", tier: "public", secret: a ? "launch codes" : "" }, times: a ? T1 : T2, envelope },
    { collection: "clients", id: hiddenClient, data: { name: a ? "Secret Co" : "Other", tier: "private", secret: a ? "merger" : "x" }, envelope },
    { collection: "deals", id: d1, label: "lr-deal-1", data: { name: "Renewal", stage: "won", amount: 100, client, region: "eu", notes: a ? "zebra target" : "", margin: a ? 90 : 1, partner: a ? hiddenClient : client, contract: a ? { secret: "x" } : {} }, times: T1, envelope },
    { collection: "deals", id: d2, label: "lr-deal-2", data: { name: "Pilot", stage: "lead", amount: 50, client: hiddenClient, region: "eu", notes: a ? "" : "zebra", margin: a ? 5 : 70 }, times: T2, envelope },
    { collection: "deals", id: d3, label: "lr-deal-3", data: { name: "Expansion", stage: "lead", amount: 50, client, region: "eu", margin: a ? 40 : 33 }, times: T2, envelope },
    { collection: "deals", id: hiddenDeal, data: { name: a ? "Megadeal" : "Small", stage: "won", amount: a ? 9000 : 1, client, region: "us", notes: "zebra" }, times: a ? T2 : T1, envelope },
    ...(a
      ? [{ collection: "deals", id: "old-secret", data: { name: "Old secret", stage: "won", amount: 7, client, region: "eu", notes: "zebra" }, envelope: { archive: { archivedAt: T1, archivedBy: "member:alice" } } } as Seed]
      : []),
    { collection: "activities", id: id("kickoff-call", "a-1"), label: "lr-act-1", data: { title: "Kickoff call", deal: d1, kind: "call" }, times: T1, envelope },
    { collection: "activities", id: id("intro-call", "a-2"), label: "lr-act-2", data: { title: "Intro call", deal: hiddenDeal, kind: "call" }, times: T1, envelope },
    { collection: "activities", id: id("private-note", "a-9"), data: { title: a ? "Private note" : "Note", deal: a ? d1 : d3, kind: "private", body: a ? "salary" : "" }, envelope },
    { collection: "vault", id: id("crown-jewels", "v-1"), data: { name: a ? "Crown jewels" : "Spoons" }, envelope },
    // "brief" also sits in a hidden field and on a hidden row of "a".
    { collection: "tasks", id: id("write-brief", "t-1"), label: "lr-task-1", data: { title: "Write brief", status: "open", deal: d1, effort: 3, secret: a ? "x" : "", field: "x", op: "open", owner: "alice" }, times: T1, envelope },
    { collection: "tasks", id: id("send-quote", "t-2"), label: "lr-task-2", data: { title: "Send quote", status: "done", deal: d1, effort: 1, owner: "alice" }, times: T2, envelope },
    { collection: "tasks", id: id("plan-pilot", "t-3"), label: "lr-task-3", data: { title: "Plan pilot", status: "open", deal: d2, effort: 2, secret: a ? "brief" : "", owner: "alice" }, times: T1, envelope },
    { collection: "tasks", id: id("chase", "t-4"), label: "lr-task-4", data: { title: "Chase", status: "open", deal: hiddenDeal, effort: 5, owner: "bob" }, times: T2, envelope },
    { collection: "tasks", id: id("private-brief", "t-9"), data: { title: a ? "Private brief" : "Other", status: "private", deal: d1, effort: a ? 9 : 1, owner: a ? "alice" : "carol" }, envelope },
    // Ids in "a" run the other way, so rows taken in id order would add up
    // differently.
    ...ORDERS.map(([region, channel, amount], i): Seed => ({
      collection: "orders",
      id: a ? `order-${"kjihgfedcba"[i]}` : `o-${i + 1}`,
      label: `lr-order-${i + 1}`,
      data: { title: a ? `Order ${i}` : `#${i}`, region, channel, tags: region === "eu" ? ["vip"] : ["new", "vip"], amount, cost: a ? amount * 3 : 0, status: a ? "open" : "paid", owner: a ? "alice" : "bob", deal: a ? d1 : d3 },
      times: a ? T1 : T2,
      envelope,
    })),
    ...(a
      ? (["us", "eu", "us"] as const).map((region, i): Seed => ({ collection: "orders", id: `void-${i}`, data: { region, channel: "shop", amount: 500, status: "void" }, envelope }))
      : [{ collection: "orders", id: "o-void", data: { region: "eu", channel: "web", amount: 5, status: "void" }, envelope } as Seed]),
    ...(a
      ? [{ collection: "orders", id: "old-order", data: { region: "us", channel: "shop", amount: 40, status: "open" }, envelope: { ...envelope, archive: { archivedAt: T1, archivedBy: "member:alice" } } } as Seed]
      : []),
  ];
}

const SPACES = { a: "probe-a", b: "probe-b" } as const;
const SECRET = new Uint8Array(32).fill(7);
let labelledKeys: Record<"a" | "b", LinkKey>;

async function seed(v: "a" | "b") {
  const spaceId = SPACES[v];
  for (const [collectionId, fields] of Object.entries(SCHEMAS)) {
    const result = await writeRecordCollectionSchema(spaceId, buildRecordCollectionSchema({ id: collectionId, name: collectionId, fields: fields as never }));
    expect(result.error).toBeNull();
  }
  const labels = new Map<string, string>();
  for (const row of variant(v)) {
    if (row.label) labels.set(`${row.collection}\0${row.id}`, row.label);
    const record = {
      version: 1,
      kind: "worktable.record",
      id: row.id,
      collectionId: row.collection,
      createdAt: row.times ?? (v === "a" ? T1 : T2),
      updatedAt: row.times ?? (v === "a" ? T2 : T1),
      createdBy: "user",
      metadata: {},
      data: row.data,
      ...row.envelope,
    } as RecordFile;
    const result = await writeRecord(spaceId, record);
    expect(result.error).toBeNull();
  }
  // The real key, except that each visible row gets the same id in both
  // workspaces: that is what an HMAC of two different stored ids cannot give
  // a byte comparison. The ids come only from here, so a stored id reaching a
  // response by any other path shows up as a difference, and a hidden row
  // given an id shows up as "lr-unlabelled-<stored id>".
  const real = createLinkKey(SECRET);
  return {
    recordId: (collectionId: string, storedId: string) => labels.get(`${collectionId}\0${storedId}`) ?? `lr-unlabelled-${storedId}`,
    tag: real.tag,
  } satisfies LinkKey;
}

async function ask(v: "a" | "b", collectionId: string, query: unknown, key = labelledKeys[v]): Promise<{ status: number; body: unknown }> {
  try {
    const view = await openLinkReadView(SPACES[v], GRANT, key);
    return { status: 200, body: await queryRecords(SPACES[v], collectionId, query, { view }) };
  } catch (error) {
    const failure = linkQueryFailure(error);
    if (!failure) throw error;
    return failure;
  }
}

let workspaceDir: string;
let appDir: string;

function useWorkspace(each: boolean) {
  const setup = async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "worktable-link-grant-ws-"));
    appDir = mkdtempSync(join(tmpdir(), "worktable-link-grant-app-"));
    mkdirSync(join(workspaceDir, "spaces"), { recursive: true });
    setWorkspaceRootOverride(workspaceDir);
    setAppDirOverride(appDir);
    recordIndex.start();
    await recordIndex.whenReady();
  };
  const teardown = async () => {
    await recordIndex.whenIdle();
    recordIndex.stop();
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    for (const dir of [workspaceDir, appDir]) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  };
  if (each) {
    beforeEach(setup);
    afterEach(teardown);
  } else {
    beforeAll(setup);
    afterAll(teardown);
  }
}

describe("a link's read view", () => {
  useWorkspace(false);
  beforeAll(async () => {
    labelledKeys = { a: await seed("a"), b: await seed("b") };
  });

  it("answers every probe identically in workspaces that differ only in what the grant hides", async () => {
    const leaf = (field: string, op: string) => ({ field, op, value: op === "isEmpty" ? true : op === "contains" ? "e" : op === "eq" ? "zebra target" : 10 });
    const hiddenPaths = ["notes", "margin", "region", "partner", "contract", "createdBy", "updatedBy", "metadata", "archive", "extraTop", "partner.name", "client.secret", "client.tier", "client.createdAt", "nonexistent"];
    const probes: [string, unknown][] = [
      ["deals", {}],
      ["deals", { limit: 50, select: ["name", "notes", "margin", "createdBy"] }],
      // Filters on hidden fields, hidden relation fields and the envelope.
      ...hiddenPaths.flatMap((field) => ["eq", "gt", "contains", "isEmpty"].map((op): [string, unknown] => ["deals", { where: leaf(field, op) }])),
      ["deals", { where: { notes: "zebra target" } }],
      ["deals", { where: { field: "id", op: "eq", value: "renewal" } }],
      ["deals", { where: { field: "client", op: "isEmpty" } }],
      ["deals", { where: { field: "client.name", op: "eq", value: "Acme" } }],
      ["deals", { where: { or: [{ field: "stage", op: "eq", value: "won" }, { field: "margin", op: "gt", value: 50 }] } }],
      // Search reaches granted values only.
      ["deals", { search: "zebra" }],
      ["deals", { search: "Megadeal" }],
      ["deals", { search: "renewal" }],
      ["deals", { search: "x".repeat(201) }],
      // Sorting on hidden values.
      ["deals", { orderBy: "margin" }],
      ["deals", { orderBy: [{ field: "notes", dir: "desc" }] }],
      ["deals", { orderBy: "createdBy" }],
      ["deals", { includeArchived: true, limit: 50 }],
      // Related rows come from the target's own view.
      ["deals", { limit: 50, expand: { client: true } }],
      ["deals", { limit: 50, expand: { client: ["name", "secret", "tier"] } }],
      ["deals", { expand: { partner: true } }],
      ["activities", { expand: { deal: true } }],
      ["deals", { limit: 50, backlinks: { collection: "activities", field: "deal" } }],
      ["deals", { backlinks: { collection: "activities", field: "body" } }],
      ["deals", { backlinks: { collection: "vault", field: "name" } }],
      // Aggregates see view rows only.
      ["deals", { aggregate: { groupBy: "id", select: { n: { fn: "count" } } } }],
      ["deals", { aggregate: { groupBy: "client", select: { n: { fn: "count" } } } }],
      ["deals", { aggregate: { groupBy: "stage", select: { n: { fn: "count" }, total: { fn: "sum", field: "amount" } } } }],
      ["deals", { aggregate: { groupBy: "region", select: { n: { fn: "count" } } } }],
      ["deals", { aggregate: { groupBy: "createdBy", select: { n: { fn: "count" } } } }],
      ["deals", { aggregate: { select: { most: { fn: "max", field: "margin" } } } }],
      ["deals", { aggregate: { select: { least: { fn: "min", field: "margin" } } } }],
      // Totals over hidden, void and archived rows, and reads of a collection
      // whose rows name deals the link hides.
      ...ORDER_PROBES.map((query): [string, unknown] => ["orders", query]),
      ["deals", { backlinks: { collection: "orders", field: "region" } }],
      ...TASK_PROBES.map((query): [string, unknown] => ["tasks", query]),
      ["deals", { backlinks: { collection: "tasks", field: "deal" } }],
      // Unshown times can't be read, sorted or filtered.
      ["clients", {}],
      ["clients", { orderBy: "updatedAt" }],
      ["clients", { where: { field: "createdAt", op: "gt", value: "2000-01-01" } }],
      ["activities", {}],
      // A collection outside the grant and one that doesn't exist.
      ["vault", {}],
      ["nope", {}],
    ];

    const answers = async (v: "a" | "b") => {
      const out: string[] = [];
      for (const [collectionId, query] of probes) out.push(JSON.stringify([collectionId, query, await ask(v, collectionId, query)]));
      // Paging on a granted sort, page by page, through sealed cursors.
      let cursor: string | undefined;
      do {
        const page = await ask(v, "deals", { orderBy: "amount", limit: 1, ...(cursor ? { cursor } : {}) });
        out.push(JSON.stringify(page));
        cursor = (page.body as { nextCursor?: string }).nextCursor;
      } while (cursor);
      // Cursors the link didn't issue for this query.
      const first = (await ask(v, "deals", { orderBy: "amount", limit: 1 })).body as { nextCursor: string };
      const member = await queryRecords(SPACES[v], "deals", { orderBy: "amount", limit: 1 });
      const forged = Buffer.from(JSON.stringify({ k: [50], id: "pilot" })).toString("base64url");
      for (const [query, foreign] of [
        [{ orderBy: "amount" }, member.nextCursor!],
        [{ orderBy: "amount" }, forged],
        [{ orderBy: "amount" }, `${forged}.${first.nextCursor.split(".")[1]}`],
        [{ orderBy: "amount", where: { stage: "lead" } }, first.nextCursor],
        [{ orderBy: "margin" }, first.nextCursor],
      ] as const) out.push(JSON.stringify(await ask(v, "deals", { ...query, cursor: foreign })));
      return out;
    };

    const a = await answers("a");
    expect(await answers("b")).toEqual(a);

    // The probe proves nothing if the view shows nothing: check what "a" said.
    // Asking for 50 gets the grant's 2 a query, and a cursor for the rest.
    const deals = (await ask("a", "deals", { limit: 50 })).body as { records: RecordFile[]; total: number; nextCursor?: string };
    expect(deals.total).toBe(3);
    expect(deals.nextCursor).toEqual(expect.any(String));
    expect(deals.records.map((record) => [Object.keys(record), record.id, record.data])).toEqual([
      [["version", "kind", "id", "collectionId", "createdAt", "updatedAt", "data"], "lr-deal-2", { name: "Pilot", stage: "lead", amount: 50, client: null }],
      [["version", "kind", "id", "collectionId", "createdAt", "updatedAt", "data"], "lr-deal-3", { name: "Expansion", stage: "lead", amount: 50, client: "lr-client-1" }],
    ]);
    expect(((await ask("a", "clients", {})).body as { records: RecordFile[] }).records).toEqual([
      { version: 1, kind: "worktable.record", id: "lr-client-1", collectionId: "clients", data: { name: "Acme" } },
    ] as never);
    expect((await ask("a", "deals", { orderBy: [{ field: "amount", dir: "desc" }], backlinks: { collection: "activities", field: "deal" } })).body).toMatchObject({
      backlinks: { "lr-deal-1": ["lr-act-1"], "lr-deal-2": [] },
    });
    expect((await ask("a", "deals", { where: { field: "client.secret", op: "eq", value: "x" } }))).toEqual({
      status: 403,
      body: { error: 'This link can\'t read the field "client.secret".', code: "LINK_FIELD_NOT_AVAILABLE" },
    });
    expect(await ask("a", "vault", {})).toEqual(await ask("a", "nope", {}));
    expect(a.filter((answer) => answer.includes("lr-unlabelled"))).toEqual([]);

    // Totals count only the orders the link shows: void and archived ones
    // would lift "shop".
    const channels = (await ask("a", "orders", { aggregate: { groupBy: "channel", select: COUNT } })).body as { groups: unknown[] };
    expect(channels.groups).toEqual([{ key: "web", n: 8 }, { key: "shop", n: 3 }]);
    // Hundreds of probes, each opening a view: allow for a busy machine.
  }, 30_000);
});

describe("link grants against live schemas", () => {
  useWorkspace(true);

  it("closes a collection whose grant no longer fits its schema instead of widening it", async () => {
    await seed("a");
    const grant = LinkGrantSchema.parse({
      version: 1,
      collections: { deals: { rows: { field: "region", op: "neq", value: "us" }, fields: ["name"] } },
    });
    const key = createLinkKey(SECRET);
    const before = await queryRecords("probe-a", "deals", {}, { view: await openLinkReadView("probe-a", grant, key) });
    expect(before.records.map((record) => record.data.name).sort()).toEqual(["Expansion", "Pilot", "Renewal"]);

    // Without the field, `region neq "us"` would match the hidden row too.
    const withoutRegion = Object.fromEntries(Object.entries(SCHEMAS.deals).filter(([name]) => name !== "region"));
    await writeRecordCollectionSchema("probe-a", buildRecordCollectionSchema({ id: "deals", name: "deals", fields: withoutRegion as never }));
    expect(validateLinkGrant(grant, await readLinkGrantSchemas("probe-a", grant))).toEqual([
      { collectionId: "deals", message: 'The row condition uses "region", which isn\'t a field of this collection.' },
    ]);
    const after = await queryRecords("probe-a", "deals", {}, { view: await openLinkReadView("probe-a", grant, key) }).catch(linkQueryFailure);
    expect(after).toMatchObject({ status: 403, body: { code: "LINK_COLLECTION_NOT_AVAILABLE" } });
  });

  it("rejects grants that would show what a link can't", async () => {
    await writeRecordCollectionSchema("probe-a", buildRecordCollectionSchema({
      id: "notes",
      name: "notes",
      fields: { title: { type: "text" }, page: { type: "document" }, deal: { type: "relation", references: "deals" }, kind: { type: "text" }, later: { type: "hologram" }, constructor: { type: "text" } },
    }));
    // A row condition reads a data field named like the envelope ("kind"),
    // and never the envelope itself ("updatedBy"). Showing "kind" is refused:
    // a link's queries would read the record's own kind instead.
    const grant = LinkGrantSchema.parse({
      version: 1,
      collections: {
        notes: {
          rows: { and: [{ field: "deal.name", op: "eq", value: "x" }, { field: "updatedBy", op: "eq", value: "y" }, { field: "kind", op: "eq", value: "z" }, { field: "constructor", op: "contains", value: "native" }] },
          fields: ["title", "page", "deal", "gone", "kind", "later"],
          writes: { update: true },
        },
        missing: { fields: [] },
      },
    });
    expect(validateLinkGrant(grant, await readLinkGrantSchemas("probe-a", grant)).map((issue) => `${issue.collectionId}: ${issue.message}`)).toEqual([
      'notes: Field "page" holds document links, which links can\'t show yet.',
      'notes: Field "deal" points at a collection this link doesn\'t open.',
      'notes: Field "gone" doesn\'t exist.',
      'notes: Field "kind" has a name records use for themselves, so links can\'t show it.',
      'notes: Field "later" has a type links can\'t show yet.',
      'notes: The row condition can\'t follow "deal.name" into another collection.',
      'notes: The row condition uses "updatedBy", which isn\'t a field of this collection.',
      'notes: The row condition can\'t use the field "constructor".',
      "notes: Links can't change records yet.",
      "missing: This collection doesn't exist.",
    ]);
  });

  it("gives each link its own ids that reveal nothing about the stored ones", () => {
    const one = createLinkKey(SECRET);
    const id = one.recordId("deals", "renewal");
    expect(id).toMatch(/^lr-[a-z2-7]{24}$/);
    expect(CanonicalIdSchema.safeParse(id).success).toBe(true);
    expect(createLinkKey(SECRET).recordId("deals", "renewal")).toBe(id);
    expect(createLinkKey(new Uint8Array(32).fill(8)).recordId("deals", "renewal")).not.toBe(id);
    expect(one.recordId("clients", "renewal")).not.toBe(id);
  });
});
