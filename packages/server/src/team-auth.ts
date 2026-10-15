import { AsyncLocalStorage } from "node:async_hooks"
import { betterAuth, type BetterAuthOptions } from "better-auth"
import { APIError, createAuthEndpoint } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import { getMigrations } from "better-auth/db/migration"
import { organization } from "better-auth/plugins"
import { createAccessControl } from "better-auth/plugins/access"
import {
  advanceTeamPolicy,
  currentTeamWorktable,
  openTeamDatabase,
  currentWorktableId,
  teamDatabasePath,
  teamSecret,
  TeamStateError,
} from "./team-database.ts"
import {
  findTeamMember,
  isTeamRole,
  recordTeamEnrollment,
  retireTeamEnrollment,
} from "./team-members.ts"
import { isHosted } from "./hosted.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { resolveConfiguredWorkspaceOrigin } from "./workspace-origin.ts"
import type { Database } from "bun:sqlite"

const administrativeAccess = createAccessControl({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
} as const)

/** This context can only be established after the gateway assertion is verified. */
const cloudExecution = new AsyncLocalStorage<{
  userId?: string
  worktableId: string
  identity?: NonNullable<
    import("./token-store.ts").TokenIdentity["cloudIdentity"]
  >
}>()

function teamAuthOptions(origin: string) {
  const db = openTeamDatabase(true)!
  return {
    appName: "Worktable",
    baseURL: origin,
    basePath: "/auth/team",
    secret: teamSecret(db),
    database: db,
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: !isHosted(),
      // HTTP signup is not mounted. Bootstrap/enrollment invoke this API only
      // after proving operator authority or a valid invitation capability.
      requireEmailVerification: false,
      password: {
        hash: (password) =>
          Bun.password.hash(password, { algorithm: "argon2id" }),
        verify: ({ hash, password }) => Bun.password.verify(password, hash),
      },
    },
    session: { cookieCache: { enabled: false }, expiresIn: 60 * 60 * 24 * 7 },
    account: { accountLinking: { enabled: false } },
    advanced: { cookiePrefix: "worktable-team" },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        membershipLimit: Number.MAX_SAFE_INTEGER,
        requireEmailVerificationOnInvitation: false,
        invitationExpiresIn: 60 * 60 * 48,
        ac: administrativeAccess,
        roles: {
          owner: administrativeAccess.newRole({
            organization: ["update", "delete"],
            member: ["create", "update", "delete"],
            invitation: ["create", "cancel"],
          }),
          member: administrativeAccess.newRole({
            invitation: ["create", "cancel"],
          }),
        },
        organizationHooks: {
          beforeCreateInvitation: async ({
            invitation,
            inviter,
            organization: org,
          }) => {
            const worktable = currentTeamWorktable()
            if (
              !worktable ||
              org.id !== worktable.organizationId ||
              invitation.role !== "member" ||
              !findTeamMember(inviter.id)
            ) {
              throw new APIError("FORBIDDEN", {
                message: "Only active members can invite ordinary members",
              })
            }
          },
          beforeAcceptInvitation: async ({ invitation, organization: org }) => {
            const worktable = currentTeamWorktable()
            if (
              !worktable ||
              org.id !== worktable.organizationId ||
              invitation.role !== "member" ||
              !findTeamMember(invitation.inviterId)
            ) {
              throw new APIError("FORBIDDEN", {
                message: "This invitation is no longer authorized",
              })
            }
          },
          beforeUpdateMemberRole: async ({ newRole }) => {
            if (!isTeamRole(newRole))
              throw new APIError("BAD_REQUEST", {
                message: "Unknown member role",
              })
          },
          afterAddMember: async ({ member, user }) =>
            recordTeamEnrollment(member, user.name),
          afterAcceptInvitation: async ({ member, user }) =>
            recordTeamEnrollment(member, user.name),
          afterRemoveMember: async ({ member }) =>
            retireTeamEnrollment(member.id, member.organizationId),
          afterUpdateMemberRole: async ({ member }) => {
            const worktable = db
              .query<
                { id: string },
                [string]
              >("SELECT id FROM wt_worktables WHERE organization_id = ?")
              .get(member.organizationId)
            if (worktable) advanceTeamPolicy(worktable.id)
          },
        },
      }),
      {
        id: "worktable-cloud-context",
        endpoints: {
          worktableCloudIdentity: createAuthEndpoint(
            "/worktable-cloud-identity",
            { method: "POST" },
            async (ctx) => {
              const verified = cloudExecution.getStore()
              if (
                !isHosted() ||
                !verified?.identity ||
                verified.worktableId !== currentWorktableId()
              )
                throw new APIError("FORBIDDEN")
              const identity = verified.identity
              const binding = db
                .query<
                  { user_id: string; company_id: string | null },
                  [string, string, string]
                >("SELECT user_id, company_id FROM wt_identity_bindings WHERE worktable_id = ? AND issuer = ? AND subject = ?")
                .get(verified.worktableId, identity.issuer, identity.subject)
              if (binding) {
                const user = await ctx.context.internalAdapter.findUserById(
                  binding.user_id
                )
                if (!user) throw new APIError("FORBIDDEN")
                // Update this verified subject's profile; never look up or link an account by email.
                if (user.email !== identity.email.toLowerCase())
                  await ctx.context.internalAdapter.updateUser(
                    binding.user_id,
                    {
                      email: identity.email.toLowerCase(),
                      emailVerified: false,
                    }
                  )
                if (
                  identity.companyId &&
                  identity.companyId !== binding.company_id
                )
                  db.query(
                    "UPDATE wt_identity_bindings SET company_id = ? WHERE worktable_id = ? AND issuer = ? AND subject = ?"
                  ).run(
                    identity.companyId,
                    verified.worktableId,
                    identity.issuer,
                    identity.subject
                  )
                return ctx.json({ userId: binding.user_id })
              }
              // Creating a distinct provider subject never links by email. A
              // collision requires explicit identity recovery, not an implicit merge.
              const user = await ctx.context.internalAdapter.createUser(
                {
                  name: identity.name,
                  email: identity.email,
                  emailVerified: false,
                },
                ctx
              )
              db.query(
                "INSERT INTO wt_identity_bindings(worktable_id, issuer, subject, user_id, company_id) VALUES (?, ?, ?, ?, ?)"
              ).run(
                verified.worktableId,
                identity.issuer,
                identity.subject,
                user.id,
                identity.companyId ?? null
              )
              return ctx.json({ userId: user.id })
            }
          ),
          worktableCloudContext: createAuthEndpoint(
            "/worktable-cloud-context",
            { method: "POST" },
            async (ctx) => {
              const verified = cloudExecution.getStore()
              const worktable = currentTeamWorktable()
              if (
                !verified?.userId ||
                !worktable ||
                verified.worktableId !== worktable.id
              ) {
                throw new APIError("FORBIDDEN", {
                  message: "Verified gateway identity required",
                })
              }
              const user = await ctx.context.internalAdapter.findUserById(
                verified.userId
              )
              if (!user)
                throw new APIError("UNAUTHORIZED", {
                  message: "Unknown gateway identity",
                })
              const mapping = db
                .query<{ token: string }, [string, string]>(
                  `
              SELECT s.token FROM wt_cloud_sessions c JOIN session s ON s.id = c.session_id
              WHERE c.worktable_id = ? AND c.user_id = ?
            `
                )
                .get(worktable.id, user.id)
              let current = mapping
                ? await ctx.context.internalAdapter.findSession(mapping.token)
                : null
              if (!current || current.session.expiresAt <= new Date()) {
                const session = await ctx.context.internalAdapter.createSession(
                  user.id,
                  false
                )
                if (!session) throw new TeamStateError()
                db.query(
                  "INSERT OR REPLACE INTO wt_cloud_sessions(worktable_id, user_id, session_id) VALUES (?, ?, ?)"
                ).run(worktable.id, user.id, session.id)
                current = { session, user }
              }
              await setSessionCookie(ctx, current)
              return ctx.json({ userId: user.id })
            }
          ),
        },
      },
    ],
  } satisfies BetterAuthOptions
}

function createTeamAuth(options: ReturnType<typeof teamAuthOptions>) {
  return betterAuth(options)
}

export type TeamAuth = ReturnType<typeof createTeamAuth>
const MAX_AUTH_INSTANCES = 16
const authInstances = new Map<
  string,
  { promise: Promise<TeamAuth>; settled: boolean }
>()
let schemaMigrations = new WeakMap<Database, Promise<void>>()

/** Schema migration and auth initialization are serialized per protected database. */
export function getTeamAuth(origin: string): Promise<TeamAuth> {
  const parsed = new URL(resolveConfiguredWorkspaceOrigin()?.origin ?? origin)
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new APIError("BAD_REQUEST", { message: "Invalid sign-in address" })
  origin = parsed.origin
  const key = `${teamDatabasePath()}\0${origin}\0${isHosted()}`
  const existing = authInstances.get(key)
  if (existing) {
    authInstances.delete(key)
    authInstances.set(key, existing)
    return existing.promise
  }
  if (authInstances.size >= MAX_AUTH_INSTANCES) {
    const oldest = [...authInstances].find(([, instance]) => instance.settled)
    if (!oldest)
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: "Account sign-in is busy. Try again shortly",
      })
    authInstances.delete(oldest[0])
  }
  const pending = (async () => {
    const options = teamAuthOptions(origin)
    let migration = schemaMigrations.get(options.database)
    if (!migration) {
      migration = withCrossProcessLock(
        `${teamDatabasePath()}.migration.lock`,
        { label: "Team account schema" },
        async () => {
          const migration = await getMigrations(options)
          await migration.runMigrations()
        }
      )
      schemaMigrations.set(options.database, migration)
      void migration.catch(() => schemaMigrations.delete(options.database))
    }
    await migration
    const auth = createTeamAuth(options)
    await auth.$context
    return auth
  })()
  const instance = { promise: pending, settled: false }
  authInstances.set(key, instance)
  void pending.then(
    () => {
      instance.settled = true
    },
    () => undefined
  )
  void pending.catch(() => authInstances.delete(key))
  return pending
}

/** Only call with an identity already verified against the original HTTP request. */
export async function cloudTeamSessionHeaders(
  auth: TeamAuth,
  userId: string
): Promise<Headers> {
  const worktable = currentTeamWorktable()
  if (!worktable) throw new TeamStateError()
  const { headers } = await cloudExecution.run(
    { userId, worktableId: worktable.id },
    () => auth.api.worktableCloudContext({ returnHeaders: true })
  )
  const cookie = headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ")
  return new Headers({ Cookie: cookie })
}

export function clearTeamAuthInstances(): void {
  authInstances.clear()
  schemaMigrations = new WeakMap()
}

/** The caller holds a verified, request-bound gateway proof. Never mount this API. */
export async function bindVerifiedCloudIdentity(
  origin: string,
  identity: NonNullable<
    import("./token-store.ts").TokenIdentity["cloudIdentity"]
  >
): Promise<string> {
  const auth = await getTeamAuth(origin)
  return withCrossProcessLock(
    `${teamDatabasePath()}.cloud-identities.lock`,
    { label: "Cloud identity" },
    async () => {
      const result = await cloudExecution.run(
        { worktableId: currentWorktableId(), identity },
        () => auth.api.worktableCloudIdentity()
      )
      return result.userId
    }
  )
}
