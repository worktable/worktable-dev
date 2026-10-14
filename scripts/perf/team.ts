/**
 * Sessions for the perf lane: the solo owner's password session, and the team
 * variant of a fixture (Worktable Teams turned on in a running server).
 *
 * `enableTeam` turns Teams on through the same HTTP routes the Settings page
 * uses, on the server's copy of the fixture, so solo and team runs start from
 * the same workspace at the same path:
 *
 * - the solo owner activates Teams and becomes the team's owner;
 * - a member is invited and enrolls, with edit access to about half of the
 *   Spaces (always including the ones `required` names);
 * - a second member, "other", holds grants on a few Spaces, so a grant change
 *   for someone else can be made without touching the measured member;
 * - two team agents are created.
 *
 * A checkout without Teams has no `/api/team` route; `enableTeam` then fails
 * and says so.
 */

/** A cookie as the server set it: name and value only. */
export interface Cookie {
  name: string
  value: string
}

export interface TeamAccount {
  name: string
  email: string
  password: string
  memberId: string
}

export interface TeamRoles {
  worktableId: string
  owner: TeamAccount
  member: TeamAccount
  other: TeamAccount
  agents: { id: string; name: string }[]
  /** Spaces the member can open (edit access), in the order they were granted. */
  memberSpaces: string[]
  /** Spaces the member cannot see. */
  hiddenSpaces: string[]
  /** Spaces where "other" has a grant. */
  otherSpaces: string[]
}

export type Identity = "solo" | "owner" | "member"

export const OWNER_PASSWORD = "perf-click-trace-owner"
const TEAM_PASSWORD = "perf-team-password"

export function cookiesFrom(response: Response): Cookie[] {
  return response.headers
    .getSetCookie()
    .map((header) => header.split(";", 1)[0]!)
    .map((pair) => {
      const split = pair.indexOf("=")
      return { name: pair.slice(0, split), value: pair.slice(split + 1) }
    })
    .filter((cookie) => cookie.name && cookie.value)
}

export function cookieHeader(cookies: Cookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
}

/** Requests through the local TLS proxy accept its internal certificate. */
function insecure(base: string): RequestInit {
  return base.startsWith("https:")
    ? ({ tls: { rejectUnauthorized: false } } as RequestInit)
    : {}
}

/**
 * The solo owner's session. The first call on a workspace sets the owner
 * password (the server runs with WORKTABLE_REQUIRE_AUTH=1).
 */
export async function signInSoloOwner(base: string): Promise<Cookie[]> {
  const response = await fetch(`${base}/auth/password`, {
    ...insecure(base),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: OWNER_PASSWORD }),
  })
  if (!response.ok)
    throw new Error(
      `set owner password: ${response.status} ${await response.text()}`
    )
  const cookies = cookiesFrom(response)
  if (cookies.length === 0) throw new Error("no owner session cookie")
  return cookies
}

/**
 * A team account's session at `base`. Better Auth names its cookie after the
 * origin's scheme (`__Secure-` over HTTPS), so each origin signs in itself.
 */
export async function signInTeam(
  base: string,
  account: TeamAccount
): Promise<Cookie[]> {
  const response = await fetch(`${base}/auth/team/sign-in/email`, {
    ...insecure(base),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  })
  if (!response.ok)
    throw new Error(
      `team sign-in for ${account.email}: ${response.status} ${await response.text()}`
    )
  const cookies = cookiesFrom(response)
  if (cookies.length === 0)
    throw new Error(`no team session cookie for ${account.email}`)
  return cookies
}

/** JSON request with a session; errors name the route and status. */
export async function api<T>(
  base: string,
  cookies: Cookie[],
  path: string,
  init?: { method: string; body?: unknown }
): Promise<T> {
  const response = await fetch(base + path, {
    ...insecure(base),
    method: init?.method ?? "GET",
    headers: {
      ...(init?.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      Cookie: cookieHeader(cookies),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (!response.ok)
    throw new Error(
      `${init?.method ?? "GET"} ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`
    )
  return (await response.json()) as T
}

/** Whether this server has Worktable Teams; throws a clear error if not. */
export async function requireTeamSupport(
  base: string,
  cookies: Cookie[]
): Promise<void> {
  const response = await fetch(`${base}/api/team`, {
    ...insecure(base),
    headers: { Cookie: cookieHeader(cookies) },
  })
  const type = response.headers.get("content-type") ?? ""
  if (response.status === 404 || !type.includes("application/json"))
    throw new Error(
      `Team mode is not available in this checkout: GET /api/team returned ${response.status}. ` +
        "Use --as solo (or drop --team), or measure a checkout that has Worktable Teams."
    )
  if (!response.ok)
    throw new Error(
      `GET /api/team: ${response.status} ${(await response.text()).slice(0, 300)}`
    )
}

interface SpacePolicy {
  visibility: "shared" | "restricted"
  grants: {
    subjectType: "member" | "agent"
    subjectId: string
    access: string
  }[]
}

/** Replace one subject's grant on a Space, keeping everyone else's. */
export async function setGrant(
  base: string,
  ownerCookies: Cookie[],
  spaceId: string,
  subject: { subjectType: "member" | "agent"; subjectId: string },
  access: "read" | "edit" | "manage" | null,
  visibility?: SpacePolicy["visibility"]
): Promise<void> {
  const current = await api<SpacePolicy>(
    base,
    ownerCookies,
    `/api/team/spaces/${encodeURIComponent(spaceId)}`
  )
  const grants = current.grants.filter(
    (grant) =>
      grant.subjectType !== subject.subjectType ||
      grant.subjectId !== subject.subjectId
  )
  if (access) grants.push({ ...subject, access })
  await api(
    base,
    ownerCookies,
    `/api/team/spaces/${encodeURIComponent(spaceId)}`,
    {
      method: "PUT",
      body: { visibility: visibility ?? current.visibility, grants },
    }
  )
}

async function enroll(
  base: string,
  ownerCookies: Cookie[],
  name: string,
  email: string
): Promise<TeamAccount> {
  const { invitation } = await api<{ invitation: { id: string } }>(
    base,
    ownerCookies,
    "/api/team/invitations",
    { method: "POST", body: { email } }
  )
  const response = await fetch(`${base}/auth/team/enroll`, {
    ...insecure(base),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invitationId: invitation.id,
      name,
      password: TEAM_PASSWORD,
    }),
  })
  if (!response.ok)
    throw new Error(
      `enroll ${email}: ${response.status} ${await response.text()}`
    )
  const cookies = cookiesFrom(response)
  const team = await api<{ member: { id: string } | null }>(
    base,
    cookies,
    "/api/team"
  )
  if (!team.member) throw new Error(`${email} enrolled but is not a member`)
  return { name, email, password: TEAM_PASSWORD, memberId: team.member.id }
}

/**
 * Turn Teams on for the server at `base` (direct HTTP, not the proxy), signed
 * in as the solo owner. `spaces` are all Space ids; `required` must stay
 * visible to the member (the Spaces a click trace opens).
 */
export async function enableTeam(
  base: string,
  soloOwner: Cookie[],
  spaces: string[],
  required: string[]
): Promise<TeamRoles> {
  await requireTeamSupport(base, soloOwner)
  const ownerAccount = {
    name: "Perf Owner",
    email: "perf-owner@example.test",
    password: TEAM_PASSWORD,
  }
  const activation = await fetch(`${base}/api/team/activate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(soloOwner),
    },
    body: JSON.stringify(ownerAccount),
  })
  if (!activation.ok)
    throw new Error(
      `activate Teams: ${activation.status} ${await activation.text()}`
    )
  const ownerCookies = cookiesFrom(activation)
  const team = await api<{
    worktableId: string
    member: { id: string } | null
  }>(base, ownerCookies, "/api/team")
  if (!team.member) throw new Error("the activating owner is not a member")
  const owner = { ...ownerAccount, memberId: team.member.id }
  const member = await enroll(
    base,
    ownerCookies,
    "Perf Member",
    "perf-member@example.test"
  )
  const other = await enroll(
    base,
    ownerCookies,
    "Perf Other",
    "perf-other@example.test"
  )

  // About half the Spaces for the member, the required ones first.
  const ordered = [
    ...required,
    ...[...spaces].sort().filter((id) => !required.includes(id)),
  ]
  const memberSpaces = ordered.slice(
    0,
    Math.max(required.length, Math.round(spaces.length / 2))
  )
  const hiddenSpaces = spaces.filter((id) => !memberSpaces.includes(id))
  for (const spaceId of memberSpaces)
    await setGrant(
      base,
      ownerCookies,
      spaceId,
      { subjectType: "member", subjectId: member.memberId },
      "edit",
      "restricted"
    )
  // "other" shares a few of the member's Spaces and a few hidden ones.
  const otherSpaces = [...memberSpaces.slice(0, 3), ...hiddenSpaces.slice(0, 3)]
  for (const spaceId of otherSpaces)
    await setGrant(
      base,
      ownerCookies,
      spaceId,
      { subjectType: "member", subjectId: other.memberId },
      "read",
      "restricted"
    )

  const agents: TeamRoles["agents"] = []
  for (const name of ["Perf Agent One", "Perf Agent Two"]) {
    const { agent } = await api<{ agent: { id: string; name: string } }>(
      base,
      ownerCookies,
      "/api/team/agents",
      { method: "POST", body: { name, platform: "perf", ownership: "team" } }
    )
    agents.push({ id: agent.id, name: agent.name })
  }
  return {
    worktableId: team.worktableId,
    owner,
    member,
    other,
    agents,
    memberSpaces,
    hiddenSpaces,
    otherSpaces,
  }
}
