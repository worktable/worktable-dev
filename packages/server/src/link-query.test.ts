import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSharingPolicy, LinkGrantSchema, type RecordFile, type RecordQueryResult, type WidgetFile } from "@worktable/types";
import { ownerIdentity } from "./auth.ts";
import { setAppDirOverride } from "./app-storage.ts";
import { LinkBudgets, type LinkLimitName } from "./link-budget.ts";
import { effectiveLinkGrant } from "./link-grant.ts";
import { createLinkKey } from "./link-grant-view.ts";
import { LINK_UNAVAILABLE, queryRecordsForLink, type LinkQueryResponse, type LinkReadTarget } from "./link-query.ts";
import { recordIndex } from "./record-index.ts";
import { buildRecordCollectionSchema, listRecords, writeRecord, writeRecordCollectionSchema } from "./record-store.ts";
import { activateLocalTeams } from "./team-activation.ts";
import { clearTeamAuthInstances } from "./team-auth.ts";
import { closeTeamDatabases } from "./team-database.ts";
import * as teamPolicy from "./team-policy.ts";
import type { TokenIdentity } from "./token-store.ts";
import { readWidget, setWidgetArchived, writeWidget } from "./widget-store.ts";
import { listWidgetVersions, recordWidgetVersion } from "./widget-version-store.ts";
import { prepareWorkspaceTarget, setWorkspaceRootOverride } from "./workspace.ts";
import { stringifyCanonicalYaml } from "./yaml.ts";

const SHOP = "shop";
const OTHER = "other";
const TOOL = "board";
const POLICY = defaultSharingPolicy();
const GRANT = LinkGrantSchema.parse({
  version: 1,
  collections: {
    deals: { fields: ["name", "stage"], timestamps: false },
    notes: { fields: ["title"], timestamps: false },
  },
  state: "team-read",
});
const KEY = createLinkKey(new Uint8Array(32).fill(3));
const link = (overrides: Partial<LinkReadTarget> = {}): LinkReadTarget => ({ linkId: "link-1", spaceId: SHOP, path: TOOL, linkKey: KEY, grant: GRANT, ...overrides });

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "worktable-link-query-"));
  setAppDirOverride(join(root, "app"));
  setWorkspaceRootOverride(join(root, "workspace"));
  mkdirSync(join(root, "workspace", "spaces"), { recursive: true });
});

afterEach(async () => {
  await recordIndex.whenIdle();
  recordIndex.stop();
  clearTeamAuthInstances();
  closeTeamDatabases();
  setWorkspaceRootOverride(null);
  setAppDirOverride(null);
  rmSync(root, { recursive: true, force: true });
});

function record(collectionId: string, id: string, data: Record<string, unknown>): RecordFile {
  const at = "2026-10-01T09:00:00.000Z";
  return { version: 1, kind: "worktable.record", id, collectionId, createdAt: at, updatedAt: at, createdBy: "user", metadata: {}, data } as RecordFile;
}

async function seed() {
  const collections: [string, string, Record<string, { type: string }>, Record<string, unknown>[]][] = [
    [SHOP, "deals", { name: { type: "text" }, stage: { type: "text" }, secret: { type: "text" } }, [
      { name: "Renewal", stage: "won", secret: "a" },
      { name: "Pilot", stage: "lead", secret: "b" },
      { name: "Expansion", stage: "lead", secret: "c" },
    ]],
    [SHOP, "notes", { title: { type: "text" } }, [{ title: "Kickoff" }]],
    [OTHER, "notes", { title: { type: "text" } }, [{ title: "Elsewhere" }]],
  ];
  for (const [spaceId, collectionId, fields, rows] of collections) {
    expect((await writeRecordCollectionSchema(spaceId, buildRecordCollectionSchema({ id: collectionId, name: collectionId, fields: fields as never }))).error).toBeNull();
    for (const [index, data] of rows.entries()) expect((await writeRecord(spaceId, record(collectionId, `${collectionId}-${index}`, data))).error).toBeNull();
  }
}

async function publish(permissions: Partial<WidgetFile["permissions"]>) {
  const now = new Date().toISOString();
  const written = await writeWidget(SHOP, {
    version: 1,
    kind: "worktable.widget",
    id: TOOL,
    name: "Board",
    createdAt: now,
    updatedAt: now,
    createdBy: "user",
    metadata: {},
    runtime: { type: "html", entry: "index.html" },
    permissions: { network: false, records: {}, state: { read: true, write: true }, ...permissions },
  }, "<h1>Board</h1>");
  written.release?.();
  expect(written.error).toBeNull();
}

const names = (response: { body: unknown }) => (response.body as RecordQueryResult).records.map((row) => String(row.data["name"] ?? row.data["title"])).sort();

describe("a link's records reads", () => {
  it("narrows when its tool is republished, and never widens", async () => {
    await seed();
    await publish({ records: { deals: { read: true }, notes: { read: true } } });
    const read = (collectionId: string, policy = POLICY) => queryRecordsForLink(link(), collectionId, {}, { policy, budgets: new LinkBudgets() });
    const before = [await read("deals"), await read("notes")];
    expect(before.map(names)).toEqual([["Expansion", "Pilot", "Renewal"], ["Kickoff"]]);
    await recordWidgetVersion(SHOP, TOOL, null, { source: "test" }, { operation: "create" });
    const [pinned] = await listWidgetVersions(SHOP, TOOL);

    // Every collection and the network: the link still opens only its grant.
    await publish({ network: true, records: { "*": { read: true, create: true, update: true, delete: true } } });
    expect(effectiveLinkGrant(GRANT, (await readWidget(SHOP, TOOL)).data!.permissions, POLICY)).toEqual(GRANT);
    expect([await read("deals"), await read("notes")]).toEqual(before);

    // Dropping a collection, or state reads, closes them to the link.
    await publish({ records: { deals: { read: true } }, state: { read: false, write: true } });
    const narrowed = effectiveLinkGrant(GRANT, (await readWidget(SHOP, TOOL)).data!.permissions, POLICY);
    expect([Object.keys(narrowed.collections), narrowed.state]).toEqual([["deals"], "visitor"]);
    expect(await read("deals")).toEqual(before[0]!);
    const closed = { status: 403, body: { error: "This link can't read that collection.", code: "LINK_COLLECTION_NOT_AVAILABLE" } } as const;
    expect(await read("notes")).toEqual(closed);

    // An owner policy without Records closes every collection.
    expect(await read("deals", { ...POLICY, records: "none" })).toEqual(closed);
    // A link pinned to a version reads that version's permissions...
    const readPinned = () => queryRecordsForLink(link({ pinnedVersion: pinned!.id }), "notes", {}, { policy: POLICY, budgets: new LinkBudgets() });
    expect(await readPinned()).toEqual(before[1]!);
    // ...while its tool is still there. A missing tool or version closes the link.
    expect((await setWidgetArchived(SHOP, TOOL, true)).error).toBeNull();
    for (const response of [await readPinned(), await read("deals"), await queryRecordsForLink(link({ path: "gone" }), "deals", {}, { policy: POLICY })]) {
      expect(response).toEqual(LINK_UNAVAILABLE);
    }
    expect((await setWidgetArchived(SHOP, TOOL, false)).error).toBeNull();
    expect(await queryRecordsForLink(link({ pinnedVersion: "missing" }), "deals", {}, { policy: POLICY })).toEqual(LINK_UNAVAILABLE);
  });

  it("holds a link to its budget, then lets it back in", async () => {
    await seed();
    await publish({ records: { deals: { read: true } } });
    let now = Date.parse("2026-10-21T10:00:30.000Z");
    const budgets = new LinkBudgets(() => now);
    const grant = { ...GRANT, limits: { rowsPerQuery: 200, queriesPerMinute: 3, rowsPerHour: 4 } };
    const ask = (query: unknown = {}) => queryRecordsForLink(link({ grant }), "deals", query, { policy: POLICY, budgets });
    const limited = (limit: LinkLimitName, retryAfter: number): LinkQueryResponse => ({
      status: 429,
      body: { error: "This link has reached its limit for now.", code: "LINK_LIMIT", limit, retryAfter },
      headers: { "Retry-After": String(retryAfter) },
    });

    // A refused query still counts toward the minute.
    expect((await ask({ where: { field: "secret", op: "eq", value: "a" } })).status).toBe(403);
    expect(names(await ask())).toHaveLength(3);
    // Groups have no page size: an answer that would go past the hour isn't sent.
    expect(await ask({ aggregate: { groupBy: "name", select: { n: { fn: "count" } } } })).toEqual(limited("rowsPerHour", 3570));
    expect(await ask()).toEqual(limited("queriesPerMinute", 30));

    now = Date.parse("2026-10-21T10:01:00.000Z");
    // A page holds no more rows than the hour has left, and a cursor for the rest.
    const last = await ask();
    expect([names(last).length, typeof (last.body as RecordQueryResult).nextCursor]).toEqual([1, "string"]);
    expect(await ask()).toEqual(limited("rowsPerHour", 3540));
    // Another link has its own budget.
    expect((await queryRecordsForLink(link({ linkId: "link-2", grant }), "deals", {}, { policy: POLICY, budgets })).status).toBe(200);

    now = Date.parse("2026-10-21T11:00:00.000Z");
    expect(names(await ask())).toHaveLength(3);
  });

  // 19b's risk: work started inside a visitor's request runs in the visitor
  // scope. It must be refused rather than run with trust, and leave what
  // members and the visitor read as it was.
  it("refuses index work a visitor's request starts, with a cold and a warm index", async () => {
    await seed();
    await publish({ records: { deals: { read: true } } });
    const ask = async () => names(await queryRecordsForLink(link(), "deals", {}, { policy: POLICY, budgets: new LinkBudgets() }));
    const member = async () => (await listRecords(SHOP, "deals")).map((row) => row.data["name"]).sort();
    const seeded = ["Expansion", "Pilot", "Renewal"];

    // Cold: the index is still building, so the files answer.
    recordIndex.start();
    expect(recordIndex.isReady()).toBe(false);
    expect(await ask()).toEqual(seeded);
    await recordIndex.whenReady();
    expect(await ask()).toEqual(seeded);

    // Warm: a record file changes behind the index.
    writeFileSync(join(root, "workspace", "spaces", SHOP, "records", "deals", "deals-9.yaml"), stringifyCanonicalYaml(record("deals", "deals-9", { name: "Added", stage: "won" })));
    const reconcile = teamPolicy.runAsLinkVisitor(() => teamPolicy.withLinkGrantRead(SHOP, () => recordIndex.reconcileCollection(SHOP, "deals")));
    await expect(reconcile).rejects.toBeInstanceOf(teamPolicy.TeamAccessError);
    expect([await ask(), await member()]).toEqual([seeded, seeded]);
    // Outside any request, as the index's own sweep runs, it applies.
    await recordIndex.reconcileCollection(SHOP, "deals");
    expect([await ask(), await member()]).toEqual([["Added", ...seeded], ["Added", ...seeded]]);
  });
});

// ---- The visitor scope ----------------------------------------------------

type Probe = [name: string, run: () => unknown];

/** Every exported function of team-policy, sorted by how a visitor meets it. */
const SCOPE_EXPORTS = {
  // Decides from an identity; probed inside and outside the scope.
  checks: [
    "canAccessSpace", "assertSpaceAccess", "canAccessWorktableThreads", "assertWorktableThreadAccess", "readableSpaceIds",
    "canCreateTeamSpace", "teamMemberForIdentity", "teamAgentForIdentity", "teamAgentForParticipantKey", "assertCurrentTeamIdentity", "requireTeamHuman",
    "requireTeamOwner", "teamAgentHasSpaceAccess", "agentWorktableThreadAccess", "resolveTeamAgentCredential", "currentRequestIdentity",
  ],
  // Acts for an identity, or takes one on; must refuse inside the scope.
  actions: [
    "runWithTeamIdentity", "registerTeamSpace", "getSpaceAccessPolicy", "setSpaceAccessPolicy", "createTeamAgent", "listTeamAgents",
    "bindTeamAgentCredential", "requireTeamAgentAdministrator", "updateTeamAgent", "teamAgentForCredentialAdministration", "reconnectCloudPersonalAgent",
  ],
  // Grant no access: the scope itself, trusted work that keeps the scope,
  // and lifecycle maintenance no request identity reaches.
  other: [
    "TeamAccessError", "runAsLinkVisitor", "withLinkGrantRead", "runWithoutTeamIdentity", "noteVerifiedTeamSession",
    "resetTeamSpacePoliciesAfterContentReplacement", "prepareTeamSpacePolicyResetForMissingRootRecovery",
    "finalizePendingTeamSpacePolicyReset", "retireTeamSpacePolicy",
  ],
};

/** A check allows when it neither throws nor answers no. */
function allows(run: () => unknown): boolean {
  try {
    const answer = run();
    return !(answer === false || answer == null || answer === "none" || (Array.isArray(answer) && answer.length === 0));
  } catch {
    return false;
  }
}

function checkProbes(identities: Record<string, TokenIdentity | undefined>, agent: { id: string; ownership: "personal"; memberId: string | null; spaceIds: null; worktableThreads: "edit" }): Probe[] {
  const p = teamPolicy;
  const probes: Probe[] = [
    ["currentRequestIdentity", () => p.currentRequestIdentity() ?? null],
    ["agentWorktableThreadAccess", () => p.agentWorktableThreadAccess(agent)],
  ];
  for (const space of [SHOP, OTHER]) {
    for (const access of ["read", "edit"] as const) probes.push([`teamAgentHasSpaceAccess ${space} ${access}`, () => p.teamAgentHasSpaceAccess(agent, space, access)]);
  }
  for (const [as, who] of Object.entries(identities)) {
    for (const space of [SHOP, OTHER]) {
      for (const access of ["read", "edit", "manage"] as const) {
        probes.push([`canAccessSpace ${space} ${access} ${as}`, () => p.canAccessSpace(space, access, who)]);
        probes.push([`assertSpaceAccess ${space} ${access} ${as}`, () => (p.assertSpaceAccess(space, access, who), true)]);
      }
    }
    for (const access of ["read", "edit"] as const) {
      probes.push([`canAccessWorktableThreads ${access} ${as}`, () => p.canAccessWorktableThreads(access, who)]);
      probes.push([`assertWorktableThreadAccess ${access} ${as}`, () => (p.assertWorktableThreadAccess(access, who), true)]);
    }
    probes.push([`readableSpaceIds ${as}`, () => p.readableSpaceIds(who) ?? "every Space"]);
    probes.push([`canCreateTeamSpace ${as}`, () => p.canCreateTeamSpace(who)]);
    if (!who) continue;
    probes.push(
      [`teamMemberForIdentity ${as}`, () => p.teamMemberForIdentity(who)],
      [`teamAgentForIdentity ${as}`, () => p.teamAgentForIdentity(who)],
      [`teamAgentForParticipantKey ${as}`, () => p.teamAgentForParticipantKey(who.principal.participantKey ?? `principal:${who.principal.id}`)],
      [`assertCurrentTeamIdentity ${as}`, () => (p.assertCurrentTeamIdentity(who), true)],
      [`requireTeamHuman ${as}`, () => p.requireTeamHuman(who)],
      [`requireTeamOwner ${as}`, () => p.requireTeamOwner(who)],
      [`resolveTeamAgentCredential ${as}`, () => p.resolveTeamAgentCredential(who)],
    );
  }
  return probes;
}

function actionProbes(owner: TokenIdentity, agentId: string): Probe[] {
  const p = teamPolicy;
  return [
    ["runWithTeamIdentity", () => p.runWithTeamIdentity(owner, () => true)],
    ["registerTeamSpace", () => (p.registerTeamSpace("fresh"), true)],
    ["getSpaceAccessPolicy", () => p.getSpaceAccessPolicy(SHOP)],
    ["setSpaceAccessPolicy", () => (p.setSpaceAccessPolicy({ spaceId: SHOP, visibility: "shared", grants: [] }, owner), true)],
    ["createTeamAgent", () => p.createTeamAgent({ name: "Probe", platform: "codex", ownership: "personal" }, owner)],
    ["listTeamAgents", () => p.listTeamAgents(owner)],
    ["bindTeamAgentCredential", () => (p.bindTeamAgentCredential(agentId, "local-token:probe", owner), true)],
    ["requireTeamAgentAdministrator", () => p.requireTeamAgentAdministrator(agentId, owner)],
    ["updateTeamAgent", () => p.updateTeamAgent(agentId, { name: "Renamed" }, owner)],
    ["teamAgentForCredentialAdministration", () => p.teamAgentForCredentialAdministration("local-token:agent", owner)],
    ["reconnectCloudPersonalAgent", () => (p.reconnectCloudPersonalAgent(agentId, owner), true)],
  ];
}

describe("the link visitor scope", () => {
  it("names every team-policy export", () => {
    const exported = Object.entries(teamPolicy).filter(([, value]) => typeof value === "function").map(([name]) => name).sort();
    expect(Object.values(SCOPE_EXPORTS).flat().sort()).toEqual(exported);
  });

  it("refuses every identity check in solo and Teams mode, except the grant engine's read of the link's Space", async () => {
    const coveredOutside = new Set<string>();
    const run = (mode: string, identities: Record<string, TokenIdentity | undefined>, owner: TokenIdentity, agent: Parameters<typeof checkProbes>[1]) => {
      const checks = checkProbes(identities, agent);
      // Outside the scope, so the probes are known to be able to say yes.
      for (const [name, probe] of checks) {
        if (teamPolicy.runWithTeamIdentity(owner, () => allows(probe))) coveredOutside.add(name.split(" ")[0]!);
      }
      for (const [name, probe] of [...checks, ...actionProbes(owner, agent.id)]) {
        expect([mode, name, teamPolicy.runAsLinkVisitor(() => allows(probe))]).toEqual([mode, name, false]);
        const granted = name.startsWith("canAccessSpace shop read") || name.startsWith("assertSpaceAccess shop read");
        expect([mode, name, teamPolicy.runAsLinkVisitor(() => teamPolicy.withLinkGrantRead(SHOP, () => allows(probe)))]).toEqual([mode, name, granted]);
      }
    };

    const local = ownerIdentity();
    const credential = (id: string): TokenIdentity => ({ ...local, agent: "codex", principal: { id, type: "agent", displayName: "Codex" } });
    run("solo", { nobody: undefined, owner: local, agent: credential("local-token:agent") }, local, { id: "agt_solo", ownership: "personal", memberId: null, spaceIds: null, worktableThreads: "edit" });

    const teams = join(root, "teams");
    setWorkspaceRootOverride(teams);
    prepareWorkspaceTarget(teams, "create");
    const activated = await activateLocalTeams("http://localhost:7481", { name: "Owner", email: "owner@example.test", password: "Synthetic-members-only-123" }, ownerIdentity());
    const owner = activated.identity;
    const agent = teamPolicy.createTeamAgent({ name: "Helper", platform: "codex", ownership: "personal" }, owner);
    teamPolicy.bindTeamAgentCredential(agent.id, "local-token:agent", owner);
    const agentIdentity = teamPolicy.resolveTeamAgentCredential(credential("local-token:agent"))!;
    expect(agentIdentity).not.toBeNull();
    run("teams", { nobody: undefined, owner, agent: agentIdentity, credential: credential("local-token:agent") }, owner, { ...agent, ownership: "personal", spaceIds: null, worktableThreads: "edit" });

    expect([...coveredOutside].sort()).toEqual([...SCOPE_EXPORTS.checks].sort());
  });
});
