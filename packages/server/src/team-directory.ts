import { admitWorkspaceRequest } from "./workspace-request-lifecycle.ts"
import { createHash } from "node:crypto"
import { base64url, jwtVerify } from "jose"
import { AssertionKeyring, ENV } from "@worktable/hosted-contract"
import { gatewayAdmits, isHosted } from "./hosted.ts"
import {
  advanceTeamPolicy,
  currentTeamWorktable,
  requireTeamDatabase,
  teamSecret,
} from "./team-database.ts"
import { ensureWorkspaceManifest, getWorkspaceRoot } from "./workspace.ts"
import {
  listedWorkspaceMark,
  listedWorkspaceMarkKey,
} from "./workspace-logo.ts"

export const TEAM_DIRECTORY_PATH = "/_worktable/team-directory"

/** Platform discovery only. Membership and content authority stay in this runtime. */
export async function serveTeamDirectory(request: Request): Promise<Response> {
  const unavailable = () =>
    new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    })
  const cloudId = process.env[ENV.CLOUD_WORKSPACE_ID]
  const resource = process.env[ENV.RESOURCE_URL]
  if (
    !isHosted() ||
    request.method !== "GET" ||
    !gatewayAdmits(request) ||
    !cloudId ||
    !resource
  )
    return unavailable()
  let release: (() => void) | null = null
  try {
    const keys = AssertionKeyring.parse(
      JSON.parse(process.env[ENV.BROWSER_ASSERTION_KEYRING] ?? "null")
    )
    const token = request.headers
      .get("Authorization")
      ?.match(/^Bearer (\S+)$/)?.[1]
    if (!token) return unavailable()
    const { payload } = await jwtVerify(
      token,
      (header) => {
        if (header.typ !== "worktable-directory+jwt")
          throw new Error("Wrong credential purpose")
        const key = keys.find((key) => key.kid === header.kid)
        if (!key) throw new Error("Unknown key")
        return base64url.decode(key.secret)
      },
      {
        algorithms: ["HS256"],
        issuer: `${new URL(resource).origin}/_worktable/control`,
        audience: `urn:worktable:team-directory:${cloudId}`,
        requiredClaims: ["iat", "exp"],
      }
    )
    if (!payload.iat || !payload.exp || payload.exp - payload.iat > 60)
      return unavailable()
    // Discovery reads stay available during a backup; a replacement refuses them.
    release = admitWorkspaceRequest("read")
    if (!release)
      return new Response(null, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      })
    const worktable = currentTeamWorktable()
    if (!worktable) return new Response(null, { status: 204 })
    const db = requireTeamDatabase()
    const manifest = ensureWorkspaceManifest()
    const name = manifest.name
    // A reader that asks for marks also gets the color and logo.
    const marks = payload["marks"] === true
    const mark = marks
      ? await listedWorkspaceMark(getWorkspaceRoot(), manifest)
      : null
    const markKey = listedWorkspaceMarkKey(manifest)
    // Include manifest changes made by any supported writer in the same
    // monotonic discovery revision, without depending on wall-clock order.
    db.transaction(() => {
      const read = (key: string) =>
        db
          .query<
            { value: string },
            [string]
          >("SELECT value FROM wt_config WHERE key = ?")
          .get(key)?.value
      const write = (key: string, value: string) =>
        db
          .query(
            "INSERT INTO wt_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          )
          .run(key, value)
      const previousName = read("directory_name")
      // Cloud keeps a mark only from a newer revision, so the first one it
      // can take advances the revision too.
      const previousMark = marks ? read("directory_mark") : markKey
      if (
        (previousName !== undefined && previousName !== name) ||
        previousMark !== markKey
      )
        advanceTeamPolicy(worktable.id)
      if (previousName !== name) write("directory_name", name)
      if (previousMark !== markKey) write("directory_mark", markKey)
    })()
    const members = db
      .query<
        {
          subject: string
          memberId: string
          actorId: string
          role: "owner" | "member"
        },
        [string, string]
      >(
        `
      SELECT i.subject, e.id AS memberId, e.actor_id AS actorId, m.role
      FROM wt_identity_bindings i JOIN wt_enrollments e ON e.user_id = i.user_id AND e.worktable_id = i.worktable_id
      JOIN member m ON m.id = e.id
      WHERE i.worktable_id = ? AND i.issuer = ? AND e.active = 1 AND m.role IN ('owner', 'member')
      ORDER BY i.subject
    `
      )
      .all(worktable.id, process.env[ENV.AUTH_SERVER_URL]!)
    return Response.json(
      {
        workspaceId: cloudId,
        name,
        ...mark,
        portableWorkspaceId: worktable.id,
        epoch: createHash("sha256").update(teamSecret(db)).digest("hex"),
        revision: currentTeamWorktable()!.policyRevision,
        capturedAt: Date.now(),
        members,
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch {
    return unavailable()
  } finally {
    release?.()
  }
}
