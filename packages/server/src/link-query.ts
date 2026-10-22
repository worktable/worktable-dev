// The one way a share link reads Records. A visitor's request reaches Records
// only through queryRecordsForLink. It narrows the link's grant to what the
// tool may read now and what the owner policy allows, charges the link's
// budget, and runs the query as a link visitor: every identity check refuses
// there, except reading the link's own Space while this engine does it.

import type { LinkGrant, RecordFile, RecordQueryResult, RecordCollectionSchema, SharingPolicy, WidgetFile } from "@worktable/types";
import { linkBudgets, type LinkBudgets, type LinkLimitName } from "./link-budget.ts";
import { effectiveLinkGrant } from "./link-grant.ts";
import { linkQueryFailure, openLinkReadView, type LinkKey } from "./link-grant-view.ts";
import { queryRecords } from "./record-store.ts";
import { runAsLinkVisitor, TeamAccessError, withLinkGrantRead } from "./team-policy.ts";
import { getWidgetVersion } from "./widget-version-store.ts";
import { readWidget } from "./widget-store.ts";

/** A link as its records reads need it. */
export interface LinkReadTarget {
  linkId: string;
  spaceId: string;
  /** Where the link's document is now. The link's resolution finds it by document id. */
  path: string;
  /** Keep one per link: its memo spares repeat queries the HMACs. */
  linkKey: LinkKey;
  grant: LinkGrant;
  /** Read the tool's permissions at this version instead of the current one. */
  pinnedVersion?: string | null;
}

/** What a visitor is told when a query doesn't run. Never hints at permissions to add. */
export interface LinkVisitorError {
  error: string;
  code: string;
  limit?: LinkLimitName;
  retryAfter?: number;
}

export type LinkQueryResponse =
  | { status: 200; body: RecordQueryResult; headers?: undefined }
  | { status: 400 | 403 | 404 | 429; body: LinkVisitorError; headers?: Record<string, string> };

/** The same answer for every link that can't be served, whatever the reason. */
export const LINK_UNAVAILABLE = { status: 404, body: { error: "This link isn't available.", code: "LINK_UNAVAILABLE" } } as const satisfies LinkQueryResponse;

/**
 * Runs a visitor's records query through a link. `policy` is the owner
 * policy as it is now; it is checked on every call, so tightening it cuts
 * existing links off.
 */
export async function queryRecordsForLink(
  target: LinkReadTarget,
  collectionId: string,
  query: unknown,
  options: { policy: SharingPolicy; budgets?: LinkBudgets; permissions?: WidgetFile["permissions"]; schemas?: ReadonlyMap<string, RecordCollectionSchema>; loadRows?: (collectionId: string) => Promise<RecordFile[]>; memo?: (load: () => Promise<RecordQueryResult>, rowsPerQuery: number) => Promise<RecordQueryResult>; onQueryRows?: (collectionId: string, rows: readonly RecordFile[]) => void },
): Promise<LinkQueryResponse> {
  const budgets = options.budgets ?? linkBudgets;
  // Limits come from the grant and the policy, never from the tool, so a
  // link over its budget is refused before anything is read.
  const { limits } = target.grant;
  const admission = budgets.admit(target.linkId, limits);
  if (!admission.ok) return limitReached(admission);
  return runAsLinkVisitor(() => withLinkGrantRead(target.spaceId, async (): Promise<LinkQueryResponse> => {
    try {
      const permissions = options.permissions ?? await toolPermissions(target);
      if (!permissions) return LINK_UNAVAILABLE;
      const grant = effectiveLinkGrant(target.grant, permissions, options.policy);
      // A page never holds more rows than the link has left this hour.
      const page = { ...grant.limits, rowsPerQuery: Math.min(grant.limits.rowsPerQuery, admission.rowsLeft) };
      const load = async () => {
        const view = await openLinkReadView(target.spaceId, { ...grant, limits: page }, target.linkKey, { linkId: target.linkId, schemas: options.schemas, loadRows: options.loadRows, onQueryRows: options.onQueryRows });
        return queryRecords(target.spaceId, collectionId, query, { view });
      };
      const result = options.memo ? await options.memo(load, page.rowsPerQuery) : await load();
      const taken = budgets.take(target.linkId, rowsRead(result), limits);
      return taken.ok ? { status: 200, body: result } : limitReached(taken);
    } catch (error) {
      if (error instanceof TeamAccessError) return { status: 403, body: { error: "This link can't read that.", code: "LINK_FORBIDDEN" } };
      const failure = linkQueryFailure(error);
      if (failure) return failure;
      throw error;
    }
  }));
}

function limitReached(refusal: { limit: LinkLimitName; retryAfter: number }): LinkQueryResponse {
  return {
    status: 429,
    body: { error: "This link has reached its limit for now.", code: "LINK_LIMIT", limit: refusal.limit, retryAfter: refusal.retryAfter },
    headers: { "Retry-After": String(refusal.retryAfter) },
  };
}

/** The tool's record permissions, read the way its own records calls read them. */
async function toolPermissions(target: LinkReadTarget): Promise<WidgetFile["permissions"] | null> {
  // A pinned link still needs its tool to be there now.
  const { data: widget } = await readWidget(target.spaceId, target.path);
  if (!widget || widget.archive) return null;
  if (!target.pinnedVersion) return widget.permissions;
  const version = await getWidgetVersion(target.spaceId, target.path, target.pinnedVersion);
  return version?.after.content.widget.permissions ?? null;
}

/** Every row a result carries: records, expanded rows, backlink ids and groups. */
function rowsRead(result: RecordQueryResult): number {
  let rows = result.records.length + (result.groups?.length ?? 0);
  for (const bucket of Object.values(result.expanded ?? {})) rows += Object.keys(bucket).length;
  for (const ids of Object.values(result.backlinks ?? {})) rows += ids.length;
  return rows;
}
