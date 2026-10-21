import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { CanonicalIdSchema, LinkGrantSchema, type LinkGrant, type RecordFile } from "@worktable/types";
import { ownerIdentity } from "./auth.ts";
import { setAppDirOverride } from "./app-storage.ts";
import { shapeDigest, unrecordedReads } from "./link-fixed-reads.ts";
import { readLinkGrantSchemas, validateLinkGrant } from "./link-grant.ts";
import { createLinkKey, linkQueryFailure, openLinkReadView, type LinkKey } from "./link-grant-view.ts";
import { recordIndex } from "./record-index.ts";
import { buildRecordCollectionSchema, queryRecords, writeRecord, writeRecordCollectionSchema } from "./record-store.ts";
import { linkGrantsRouter } from "./routes/link-grants.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";

// ---- Two workspaces that differ only in what the grant hides -------------
//
// "a" and "b" hold the same visible rows: same granted values, same shown
// times, relations to the same visible rows. Everything else differs: hidden
// fields, hidden and archived rows, the envelope (format version, createdBy,
// metadata, unknown top-level keys), unshown times, and every stored id, which in "a" is a slug
// of the title. A link query that answers differently in the two leaks.
// Orders are granted only as totals, so there only the groupings and measures
// of visible rows match: even the order rows are stored in differs. Tasks are
// granted only through saved reads, one of which hard-codes a stored id: the
// tool saved in each workspace names that workspace's id for the same deal.

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
    owner: { type: "person" },
  },
} as const;

// The renewal deal's stored id, which differs between the workspaces.
const renewalId = (v: "a" | "b") => (v === "a" ? "renewal" : "d-1");
const pilotId = (v: "a" | "b") => (v === "a" ? "pilot" : "d-2");

// The saved reads of a task board: open or done tasks (the board may switch
// between them, and also saved a one-row version), the renewal deal's tasks
// by its stored id, a search box, and one person's open tasks by a field the
// link doesn't show.
const BOARD = {
  where: { and: [{ field: "effort", op: "gte", value: 1 }, { field: "status", op: "eq", value: "open" }] },
  orderBy: [{ field: "title", dir: "asc" }],
  select: ["deal", "status", "title"],
};
const savedReads = (v: "a" | "b") => [
  { id: "board-peek", query: { ...BOARD, limit: 1 }, params: { "/where/and/1/value": { kind: "oneOf", values: ["open", "done"] } } },
  { id: "board", query: BOARD, params: { "/where/and/1/value": { kind: "oneOf", values: ["open", "done"] } } },
  { id: "renewal", query: { where: { field: "deal", op: "eq", value: renewalId(v) }, expand: { deal: ["name"] } } },
  { id: "search", query: { search: "brief", orderBy: [{ field: "effort", dir: "desc" }] }, params: { "/search": { kind: "any" } } },
  { id: "mine", query: { where: { and: [{ field: "owner", op: "eq", value: "alice" }, { field: "status", op: "eq", value: "open" }] }, orderBy: [{ field: "title", dir: "asc" }] } },
  // A deal picker that lists the deals by stored id.
  { id: "by-deal", query: { where: { field: "deal", op: "eq", value: renewalId(v) }, select: ["title"] }, params: { "/where/value": { kind: "oneOf", values: [renewalId(v), pilotId(v)] } } },
];

const grantFor = (v: "a" | "b"): LinkGrant => LinkGrantSchema.parse({
  version: 1,
  collections: {
    deals: { rows: { field: "region", op: "eq", value: "eu" }, fields: ["name", "stage", "amount", "client"] },
    clients: { rows: { field: "tier", op: "eq", value: "public" }, fields: ["name"], timestamps: false },
    activities: { rows: { field: "kind", op: "eq", value: "call" }, fields: ["title", "deal"] },
    orders: {
      rows: { field: "status", op: "neq", value: "void" },
      fields: [],
      mode: "summaries",
      summaries: { groupBy: ["region", "channel", "tags"], measures: ["amount"] },
    },
    tasks: {
      rows: { field: "status", op: "in", value: ["done", "open"] },
      fields: ["title", "status", "deal", "effort"],
      mode: "fixed",
      fixed: savedReads(v),
    },
  },
  limits: { rowsPerQuery: 2 },
});
const GRANTS = { a: grantFor("a"), b: grantFor("b") };
const GRANT = GRANTS.a;

// The (region, channel, amount) of every visible order, the same in both
// workspaces. "us" holds the smallest amount, and the "eu" sum changes in its
// last digit with the order its amounts are added in.
const ORDERS: [string, string, number][] = [
  ["eu", "web", 0.1], ["eu", "web", 0.2], ["eu", "web", 0.3], ["eu", "web", 0.4], ["eu", "shop", 0.7], ["eu", "shop", 1.1],
  ["us", "web", 0.05], ["us", "web", 2], ["us", "web", 4], ["us", "web", 5], ["us", "shop", 3],
];

// Totals of orders the grant allows. Groups of fewer than five are dropped.
const COUNT = { n: { fn: "count" } };
const TOTALS = { n: { fn: "count" }, total: { fn: "sum", field: "amount" }, mean: { fn: "avg", field: "amount" } };
const SUMMARY_QUERIES = [
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
];

// Everything else a summaries link refuses: a name it doesn't read gets the
// same answer as a missing one.
const ONLY = "LINK_SUMMARIES_ONLY";
const HIDDEN = "LINK_FIELD_NOT_AVAILABLE";
const ANY_TOTAL = { aggregate: { select: COUNT } };
const SUMMARY_REFUSALS: [Record<string, unknown>, string][] = [
  [{}, ONLY],
  [{ where: { region: "eu" } }, ONLY],
  ...[{ select: ["amount"] }, { expand: { deal: true } }, { backlinks: { collection: "activities", field: "deal" } }, { cursor: "x" }, { search: "eu" }, { orderBy: "amount" }, { limit: 1 }]
    .map((extra): [Record<string, unknown>, string] => [{ ...ANY_TOTAL, ...extra }, ONLY]),
  [{ aggregate: { groupBy: "amount", select: COUNT } }, ONLY],
  ...["min", "max", "unique"].map((fn): [Record<string, unknown>, string] => [{ aggregate: { select: { x: { fn, field: "amount" } } } }, ONLY]),
  [{ aggregate: { select: { x: { fn: "sum", field: "region" } } } }, ONLY],
  [{ aggregate: { select: { x: { fn: "sum" } } } }, ONLY],
  [{ aggregate: { select: { __wt_n: { fn: "count" } } } }, ONLY],
  [{ aggregate: { groupBy: "region", select: { key: { fn: "count" } } } }, ONLY],
  ...([["neq", "us"], ["contains", "u"], ["isEmpty", true], ["gt", "a"]] as const)
    .map(([op, value]): [Record<string, unknown>, string] => [{ ...ANY_TOTAL, where: { field: "region", op, value } }, ONLY]),
  [{ ...ANY_TOTAL, where: { or: [{ region: "eu" }, { channel: "web" }] } }, ONLY],
  [{ ...ANY_TOTAL, where: { not: { region: "eu" } } }, ONLY],
  [{ ...ANY_TOTAL, where: { amount: 1 } }, ONLY],
  ...["status", "title", "cost", "owner", "deal", "id", "createdAt", "createdBy", "nonexistent"].flatMap((name): [Record<string, unknown>, string][] => [
    [{ aggregate: { groupBy: name, select: COUNT } }, HIDDEN],
    [{ aggregate: { select: { x: { fn: "sum", field: name } } } }, HIDDEN],
    [{ ...ANY_TOTAL, where: { field: name, op: "eq", value: "x" } }, HIDDEN],
  ]),
  [{ ...ANY_TOTAL, where: { field: "deal.name", op: "eq", value: "Renewal" } }, HIDDEN],
];

// The board's read as its tool sends it: a flat filter, a plain sort, and
// fields in any order. It matches the saved read with any listed status.
const boardAsk = (status: unknown) => ({ where: { status, effort: { gte: 1 } }, orderBy: "title", select: ["title", "status", "deal"] });
const SAVED_READ_ASKS: Record<string, unknown>[] = [
  boardAsk("open"),
  boardAsk("done"),
  { ...boardAsk("open"), includeArchived: true, limit: 50 },
  { where: { status: "open", owner: "alice" }, orderBy: "title" },
  // A listed deal named by the id the link showed for it.
  { where: { deal: "lr-deal-2" }, select: ["title"] },
  { search: "pilot", orderBy: [{ field: "effort", dir: "desc" }] },
  { search: "brief", orderBy: [{ field: "effort", dir: "desc" }] },
];
// Each differs from every saved read: a value outside the list, a changed
// saved value (on a shown or a hidden field), another sort, an extra
// condition (on a shown, hidden or missing field), other fields, nothing at
// all, and the link's id where the read saved a stored one.
const UNSAVED_ASKS: Record<string, unknown>[] = [
  boardAsk("private"),
  { ...boardAsk("open"), where: { status: "open", effort: { gte: 2 } } },
  { where: { status: "open", owner: "bob" }, orderBy: "title" },
  { where: { deal: "lr-deal-3" }, select: ["title"] },
  { ...boardAsk("open"), orderBy: "effort" },
  ...["title", "secret", "nonexistent"].map((field) => ({ ...boardAsk("open"), where: { status: "open", effort: { gte: 1 }, [field]: "Chase" } })),
  { ...boardAsk("open"), select: ["title"] },
  {},
  { where: { deal: "lr-deal-1" }, expand: { deal: ["name"] } },
  { search: "brief" },
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
    // "brief" also sits in a hidden field and on a hidden row of "a". Owners
    // are hidden but match: one saved read picks a person's tasks by them.
    { collection: "tasks", id: id("write-brief", "t-1"), label: "lr-task-1", data: { title: "Write brief", status: "open", deal: d1, effort: 3, secret: a ? "x" : "", owner: "alice" }, times: T1, envelope },
    { collection: "tasks", id: id("send-quote", "t-2"), label: "lr-task-2", data: { title: "Send quote", status: "done", deal: d1, effort: 1, owner: "alice" }, times: T2, envelope },
    { collection: "tasks", id: id("plan-pilot", "t-3"), label: "lr-task-3", data: { title: "Plan pilot", status: "open", deal: d2, effort: 2, secret: a ? "brief" : "", owner: "alice" }, times: T1, envelope },
    { collection: "tasks", id: id("chase", "t-4"), label: "lr-task-4", data: { title: "Chase", status: "open", deal: hiddenDeal, effort: 5, owner: "bob" }, times: T2, envelope },
    { collection: "tasks", id: id("private-brief", "t-9"), data: { title: a ? "Private brief" : "Other", status: "private", deal: d1, effort: a ? 9 : 1, owner: a ? "alice" : "carol" }, envelope },
    // Ids in "a" run the other way, so rows taken in id order would add up
    // differently. Void and archived orders would lift "shop" over five.
    ...ORDERS.map(([region, channel, amount], i): Seed => ({
      collection: "orders",
      id: a ? `order-${"kjihgfedcba"[i]}` : `o-${i + 1}`,
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
    const view = await openLinkReadView(SPACES[v], GRANTS[v], key);
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
      // A collection shown only as totals, and never as rows from elsewhere.
      ...[...SUMMARY_QUERIES, ...SUMMARY_REFUSALS.map(([query]) => query)].map((query): [string, unknown] => ["orders", query]),
      ["deals", { backlinks: { collection: "orders", field: "region" } }],
      // A collection opened only through saved reads, and never from a query
      // the link doesn't save.
      ...[...SAVED_READ_ASKS, ...UNSAVED_ASKS].map((query): [string, unknown] => ["tasks", query]),
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
      // The saved read that names the renewal deal by its stored id, and the
      // same read naming another deal.
      out.push(JSON.stringify(await ask(v, "tasks", { where: { deal: renewalId(v) }, expand: { deal: ["name"] } })));
      out.push(JSON.stringify(await ask(v, "tasks", { where: { field: "deal", op: "eq", value: pilotId(v) }, expand: { deal: ["name"] } })));
      // A saved read's cursor continues it only with the values it began with.
      const board = (await ask(v, "tasks", { ...boardAsk("open"), limit: 1 })).body as { nextCursor: string };
      out.push(JSON.stringify(await ask(v, "tasks", { ...boardAsk("open"), cursor: board.nextCursor })));
      out.push(JSON.stringify(await ask(v, "tasks", { ...boardAsk("done"), cursor: board.nextCursor })));
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

    // Saved reads run in the link's ids, the hard-coded stored id included.
    const shown = async (query: unknown) => {
      const { body } = await ask("a", "tasks", query);
      const { records, expanded } = body as { records: RecordFile[]; expanded?: Record<string, Record<string, RecordFile>> };
      return { records: records.map((record) => [record.id, record.data]), expanded };
    };
    expect(await shown({ where: { deal: "renewal" }, expand: { deal: ["name"] } })).toMatchObject({
      records: [
        ["lr-task-2", { title: "Send quote", status: "done", deal: "lr-deal-1", effort: 1 }],
        ["lr-task-1", { title: "Write brief", status: "open", deal: "lr-deal-1", effort: 3 }],
      ],
      expanded: { deals: { "lr-deal-1": { id: "lr-deal-1", data: { name: "Renewal" } } } },
    });
    // The board may switch status within its list; search finds shown text only.
    expect((await shown(boardAsk("open"))).records).toEqual([
      ["lr-task-4", { title: "Chase", status: "open", deal: null }],
      ["lr-task-3", { title: "Plan pilot", status: "open", deal: "lr-deal-2" }],
    ]);
    expect((await shown(boardAsk("done"))).records).toEqual([["lr-task-2", { title: "Send quote", status: "done", deal: "lr-deal-1" }]]);
    expect((await shown({ where: { deal: "lr-deal-2" }, select: ["title"] })).records).toEqual([["lr-task-3", { title: "Plan pilot" }]]);
    // A saved condition on a hidden field picks rows without showing it.
    expect((await shown({ where: { status: "open", owner: "alice" }, orderBy: "title" })).records).toEqual([
      ["lr-task-3", { title: "Plan pilot", status: "open", deal: "lr-deal-2", effort: 2 }],
      ["lr-task-1", { title: "Write brief", status: "open", deal: "lr-deal-1", effort: 3 }],
    ]);
    expect((await shown(SAVED_READ_ASKS.at(-1))).records.map(([id]) => id)).toEqual(["lr-task-1"]);
    expect(await ask("a", "tasks", boardAsk("private"))).toEqual({
      status: 403,
      body: { error: "This link can only run the reads saved with it.", code: "LINK_QUERY_NOT_RECORDED" },
    });
    for (const query of UNSAVED_ASKS) expect({ query, ...(await ask("a", "tasks", query)) }).toMatchObject({ query, status: 403, body: { code: "LINK_QUERY_NOT_RECORDED" } });

    // Each link counts the reads it refused, by shape and never by value.
    const counted = await openLinkReadView(SPACES.a, GRANTS.a, labelledKeys.a, { linkId: "link-counted" });
    for (const query of [boardAsk("private"), boardAsk("someone's secret"), {}]) await queryRecords(SPACES.a, "tasks", query, { view: counted }).catch(() => {});
    expect(unrecordedReads("link-counted")).toMatchObject({ total: 3, reads: [{ collectionId: "tasks", count: 2 }, { collectionId: "tasks", count: 1, shapeDigest: shapeDigest("{}") }] });
    expect(unrecordedReads("link-other").total).toBe(0);
  });
});

describe("a link that shows only totals", () => {
  useWorkspace(true);

  it("answers only for groups of at least five, and refuses every other read", async () => {
    const key = await seed("a");
    const groups = async (query: unknown) => ((await ask("a", "orders", query, key)).body as { groups?: unknown[] }).groups;
    expect(await groups({ aggregate: { select: TOTALS } })).toEqual([{ n: 11, total: expect.closeTo(16.85), mean: expect.closeTo(16.85 / 11) }]);
    // Groups come in key order, which says nothing about the amounts in them.
    expect(await groups({ aggregate: { groupBy: "region", select: TOTALS } })).toEqual([
      { key: "eu", n: 6, total: expect.closeTo(2.8), mean: expect.closeTo(2.8 / 6) },
      { key: "us", n: 5, total: expect.closeTo(14.05), mean: expect.closeTo(14.05 / 5) },
    ]);
    // Three "shop" orders are visible: the void and archived ones don't count.
    expect(await groups({ aggregate: { groupBy: "channel", select: COUNT } })).toEqual([{ key: "web", n: 8 }]);
    expect(await groups({ includeArchived: true, aggregate: { groupBy: "channel", select: COUNT } })).toEqual([{ key: "web", n: 8 }]);
    // Dropped groups aren't pooled anywhere, and a small total is dropped whole.
    expect(await groups({ where: { region: "eu" }, aggregate: { groupBy: "channel", select: COUNT } })).toEqual([]);
    expect(await groups({ where: { channel: "shop" }, aggregate: { select: COUNT } })).toEqual([]);
    // A multi-select grouping narrows to one of its values with "has".
    expect(await groups({ where: { field: "tags", op: "has", value: "new" }, aggregate: { select: COUNT } })).toEqual([{ n: 5 }]);

    for (const [query, code] of SUMMARY_REFUSALS) {
      expect({ query, ...(await ask("a", "orders", query, key)) }).toMatchObject({ query, status: 403, body: { code } });
    }
  });
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
      fields: { title: { type: "text" }, page: { type: "document" }, deal: { type: "relation", references: "deals" }, kind: { type: "text" }, tally: { type: "relation", references: "tallies" }, step: { type: "relation", references: "steps" }, later: { type: "hologram" } },
    }));
    await writeRecordCollectionSchema("probe-a", buildRecordCollectionSchema({
      id: "steps",
      name: "steps",
      fields: { title: { type: "text" }, done: { type: "boolean" }, secret: { type: "text" } },
    }));
    await writeRecordCollectionSchema("probe-a", buildRecordCollectionSchema({
      id: "tallies",
      name: "tallies",
      titleField: "label",
      fields: {
        label: { type: "select" },
        code: { type: "select", unique: true },
        region: { type: "multi_select" },
        paid: { type: "boolean" },
        note: { type: "text" },
        due: { type: "date" },
        kind: { type: "select" },
        amount: { type: "number" },
        version: { type: "number" },
      },
    }));
    // A row condition reads a data field named like the envelope ("kind"),
    // and never the envelope itself ("updatedBy"). Showing "kind" is refused:
    // a link's queries would read the record's own kind instead.
    // Totals split only by few-valued fields that don't name a row, and no
    // relation may lead to the rows behind them. A collection opened through
    // saved reads is reached by no other query. A saved read leaves a value
    // open only on a field the link shows, and filters on a hidden field only
    // with a saved condition every result meets.
    const grant = LinkGrantSchema.parse({
      version: 1,
      collections: {
        notes: {
          rows: { and: [{ field: "deal.name", op: "eq", value: "x" }, { field: "updatedBy", op: "eq", value: "y" }, { field: "kind", op: "eq", value: "z" }] },
          fields: ["title", "page", "deal", "gone", "kind", "tally", "step", "later"],
          writes: { update: true },
        },
        tallies: {
          // Row fields left over from a scoped grant: a summaries view never reads them.
          fields: ["gone", "kind", "note"],
          mode: "summaries",
          summaries: { groupBy: ["region", "paid", "label", "code", "note", "kind"], measures: ["amount", "paid", "version", "gone"] },
        },
        steps: {
          fields: ["title", "done"],
          mode: "fixed",
          fixed: [
            { id: "unsorted", query: { select: ["title", "done"] } },
            { id: "open-secret", query: { where: { field: "secret", op: "eq", value: "x" } }, params: { "/where/value": { kind: "any" } } },
            { id: "listed-secret", query: { where: { field: "secret", op: "eq", value: "x" } }, params: { "/where/value": { kind: "oneOf", values: ["x", "y"] } } },
            { id: "open-field", query: { where: { field: "title", op: "eq", value: "x" } }, params: { "/where/field": { kind: "oneOf", values: ["done"] } } },
            { id: "closed-secret", query: { where: { and: [{ field: "secret", op: "eq", value: "x" }, { field: "title", op: "eq", value: "y" }] } } },
            { id: "either-secret", query: { where: { or: [{ field: "secret", op: "eq", value: "x" }, { field: "title", op: "eq", value: "y" }] } } },
            { id: "gone", query: { where: { field: "gone", op: "eq", value: "x" } } },
            { id: "by-secret", query: { orderBy: [{ field: "secret", dir: "asc" }] } },
            { id: "either-title", query: { where: { or: [{ field: "title", op: "eq", value: "a" }, { field: "title", op: "eq", value: "b" }] } }, params: { "/where/or/0/value": { kind: "any" } } },
          ],
        },
        missing: { fields: [] },
      },
    });
    expect(validateLinkGrant(grant, await readLinkGrantSchemas("probe-a", grant)).map((issue) => `${issue.collectionId}: ${issue.message}`)).toEqual([
      'notes: Field "page" holds document links, which links can\'t show yet.',
      'notes: Field "deal" points at a collection this link doesn\'t open.',
      'notes: Field "gone" doesn\'t exist.',
      'notes: Field "kind" has a name records use for themselves, so links can\'t show it.',
      'notes: Field "tally" points at a collection this link shows only as totals.',
      'notes: Field "step" points at a collection this link opens only through saved reads.',
      'notes: Field "later" has a type links can\'t show yet.',
      'notes: The row condition can\'t follow "deal.name" into another collection.',
      'notes: The row condition uses "updatedBy", which isn\'t a field of this collection.',
      "notes: Links can't change records yet.",
      'tallies: Summaries can\'t be grouped by "label". Use a select, multi-select or yes/no field.',
      'tallies: Summaries can\'t be grouped by "code". Use a select, multi-select or yes/no field.',
      'tallies: Summaries can\'t be grouped by "note". Use a select, multi-select or yes/no field.',
      'tallies: Field "kind" has a name records use for themselves, so links can\'t show it.',
      'tallies: Summary measure "paid" must be a number field.',
      'tallies: Field "version" has a name records use for themselves, so links can\'t show it.',
      'tallies: Summary measure "gone" isn\'t a field of this collection.',
      'steps: Saved read "unsorted" isn\'t in canonical form.',
      'steps: Saved read "open-secret" can leave "secret" open only if the link shows it.',
      'steps: Saved read "listed-secret" can leave "secret" open only if the link shows it.',
      'steps: Saved read "open-field" leaves "/where/field" open, which isn\'t a value it compares with.',
      'steps: Saved read "either-secret" can filter on "secret", which this link doesn\'t show, only with a condition every result meets.',
      'steps: Saved read "gone" can\'t filter on "gone", which this link doesn\'t show.',
      'steps: Saved read "by-secret" uses "secret", which this link doesn\'t show.',
      'steps: Saved read "either-title" can\'t leave "/where/or/0/value" open beside a condition of the same form.',
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

describe("run as link", () => {
  useWorkspace(true);
  let identity = ownerIdentity();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("identity", identity);
    await next();
  });
  app.route("/api/spaces", spacesRouter);
  app.route("/api/link-grants", linkGrantsRouter);
  const run = async (body: unknown) => {
    const res = await app.fetch(new Request("http://localhost/api/link-grants/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  };
  const previous = process.env["WORKTABLE_SHARING_PREVIEW"];
  afterAll(() => {
    if (previous === undefined) delete process.env["WORKTABLE_SHARING_PREVIEW"];
    else process.env["WORKTABLE_SHARING_PREVIEW"] = previous;
  });

  it("shows the owner what a visitor would get, behind the preview and only to people", async () => {
    await app.fetch(new Request("http://localhost/api/spaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Probe A" }) }));
    await seed("a");
    const body = { spaceId: "probe-a", collectionId: "deals", grant: GRANT, query: { orderBy: [{ field: "amount" }, { field: "name" }], select: ["name", "notes"] } };

    process.env["WORKTABLE_SHARING_PREVIEW"] = "0";
    expect((await run(body)).status).toBe(404);

    process.env["WORKTABLE_SHARING_PREVIEW"] = "1";
    identity = { ...ownerIdentity(), principal: { id: "agent:helper", type: "agent", displayName: "Helper" } };
    expect((await run(body)).status).toBe(403);

    identity = ownerIdentity();
    const shown = await run(body);
    expect(shown.status).toBe(200);
    expect(shown.body.records.map((record: RecordFile) => record.data)).toEqual([{ name: "Expansion" }, { name: "Pilot" }]);
    expect(shown.body.records[0].id).toMatch(/^lr-[a-z2-7]{24}$/);
    const next = await run({ ...body, query: { ...body.query, cursor: shown.body.nextCursor } });
    expect(next.body.records.map((record: RecordFile) => record.data)).toEqual([{ name: "Renewal" }]);
    // Each grant is checked as its own link: its cursors mean nothing under another.
    const other = { ...GRANT, limits: { ...GRANT.limits, rowsPerQuery: 3 } };
    const carried = await run({ ...body, grant: other, query: { ...body.query, cursor: shown.body.nextCursor } });
    expect(carried).toMatchObject({ status: 400, body: { code: "LINK_CURSOR_INVALID" } });

    const invalid = await run({ ...body, grant: { version: 1, collections: { deals: { fields: ["gone"] } } } });
    expect(invalid).toMatchObject({ status: 400, body: { code: "LINK_GRANT_INVALID", issues: [{ collectionId: "deals" }] } });
  });
});
