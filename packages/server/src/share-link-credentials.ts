import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

// Bound Argon2 work across creation, edits and visitor unlocks. Reject excess
// work instead of retaining passwords in a queue or exhausting tenant memory.
const MAX_PASSWORD_WORK = 2
let passwordWork = 0
export class SharePasswordBusy extends Error {}
const PASSWORD_OPTIONS = {
  algorithm: "argon2id",
  memoryCost: 19_456,
  timeCost: 2,
} as const

// Bun's Argon2id encoding uses a 32-byte salt and a 32-byte result.
// Keep the SQLite summary predicate identical to the verifier's format gate.
export const SHARE_PASSWORD_HASH_GLOB =
  "$argon2id$v=19$m=19456,t=2,p=1$" +
  "[A-Za-z0-9+/]".repeat(43) +
  "$" +
  "[A-Za-z0-9+/]".repeat(43)
export function supportedSharePasswordHash(hash: string): boolean {
  return /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{43}\$[A-Za-z0-9+/]{43}$/.test(
    hash
  )
}

async function withPasswordSlot<T>(work: () => Promise<T>): Promise<T> {
  if (passwordWork >= MAX_PASSWORD_WORK) throw new SharePasswordBusy()
  passwordWork++
  try {
    return await work()
  } finally {
    passwordWork--
  }
}

export function hashSharePassword(password: string): Promise<string> {
  return withPasswordSlot(() => Bun.password.hash(password, PASSWORD_OPTIONS))
}

export function verifySharePassword(
  password: string,
  hash: string
): Promise<boolean> {
  if (!supportedSharePasswordHash(hash)) return Promise.resolve(false)
  return withPasswordSlot(() =>
    Bun.password.verify(password, hash).catch(() => false)
  )
}

export interface ShareTicketLink {
  id: string
  workspaceEpoch: string
  passwordRevision: number
  grantRevision?: string
}
export type ShareTicketPurpose = "unlock" | "frame"
const PREFIX = { unlock: "u1", frame: "f1" } as const
const LIFETIME = { unlock: 12 * 60 * 60, frame: 5 * 60 } as const
const TICKET =
  /^(u1|f1)\.(lnk_[A-Za-z0-9_-]{22})\.(0|[1-9][0-9]{0,14})\.(0|[1-9][0-9]{0,14})\.([A-Za-z0-9_-]{43})$/

/** Only identifies the row to verify; this does not authorize any access. */
export function shareTicketLinkId(
  ticket: string,
  purpose: ShareTicketPurpose
): string | null {
  const match = ticket.length <= 256 ? TICKET.exec(ticket) : null
  return match?.[1] === PREFIX[purpose] ? match[2]! : null
}

function mac(
  secret: Uint8Array,
  link: ShareTicketLink,
  payload: string
): string {
  const tag = createHmac("sha256", secret)
    .update("worktable-share-ticket\0")
    .update(link.workspaceEpoch)
    .update("\0")
  // Preserve existing static tickets; executable frames also bind the exact
  // human-approved grant. Editing or removing it invalidates that ticket.
  if (link.grantRevision && link.grantRevision !== "static") {
    tag.update("grant\0").update(link.grantRevision).update("\0")
  }
  return tag.update(payload).digest("base64url")
}

export function mintShareTicket(
  secret: Uint8Array,
  link: ShareTicketLink,
  purpose: ShareTicketPurpose,
  expiresAt: number | null,
  now = Date.now()
): { ticket: string; maxAge: number } | null {
  const seconds = Math.floor(now / 1000)
  const expires = Math.min(
    seconds + LIFETIME[purpose],
    expiresAt === null ? Infinity : Math.floor(expiresAt / 1000)
  )
  if (!(expires > seconds)) return null
  const payload = `${PREFIX[purpose]}.${link.id}.${link.passwordRevision}.${expires}`
  return {
    ticket: `${payload}.${mac(secret, link, payload)}`,
    maxAge: expires - seconds,
  }
}

export function validShareTicket(
  ticket: string | undefined,
  secret: Uint8Array,
  link: ShareTicketLink,
  purpose: ShareTicketPurpose,
  now = Date.now()
): boolean {
  if (!ticket || ticket.length > 256) return false
  const match = TICKET.exec(ticket)
  if (
    !match ||
    match[1] !== PREFIX[purpose] ||
    match[2] !== link.id ||
    Number(match[3]) !== link.passwordRevision
  )
    return false
  const expiry = Number(match[4])
  const seconds = Math.floor(now / 1000)
  if (expiry <= seconds || expiry > seconds + LIFETIME[purpose]) return false
  const payload = ticket.slice(0, ticket.lastIndexOf("."))
  return timingSafeEqual(
    Buffer.from(match[5]!),
    Buffer.from(mac(secret, link, payload))
  )
}

// A legacy share may remain pending while its document identity is conflicted.
// Seal its token instead of putting a bearer token in the frame URL. The same
// workspace secret is rotated on reset; revocation is checked in the old store.
function legacyFrameKey(secret: Uint8Array): Buffer {
  return createHmac("sha256", secret)
    .update("worktable-legacy-frame-key")
    .digest()
}
export function mintLegacyFrameTicket(
  secret: Uint8Array,
  token: string,
  expiresAt: number | null,
  now = Date.now()
): string | null {
  const expiry = Math.min(
    Math.floor(now / 1000) + LIFETIME.frame,
    expiresAt === null ? Infinity : Math.floor(expiresAt / 1000)
  )
  if (expiry <= Math.floor(now / 1000) || !/^[A-Za-z0-9_-]{43}$/.test(token))
    return null
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", legacyFrameKey(secret), iv)
  cipher.setAAD(Buffer.from(`worktable-legacy-frame\0${expiry}`))
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ])
  return `lf1.${expiry}.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`
}
export function legacyFrameToken(
  secret: Uint8Array,
  ticket: string,
  now = Date.now()
): string | null {
  const match =
    /^lf1\.([1-9][0-9]{0,14})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{58})\.([A-Za-z0-9_-]{22})$/.exec(
      ticket
    )
  if (!match) return null
  const expiry = Number(match[1])
  if (
    expiry <= Math.floor(now / 1000) ||
    expiry > Math.floor(now / 1000) + LIFETIME.frame
  )
    return null
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      legacyFrameKey(secret),
      Buffer.from(match[2]!, "base64url")
    )
    decipher.setAAD(Buffer.from(`worktable-legacy-frame\0${expiry}`))
    decipher.setAuthTag(Buffer.from(match[4]!, "base64url"))
    const token = Buffer.concat([
      decipher.update(Buffer.from(match[3]!, "base64url")),
      decipher.final(),
    ]).toString("utf8")
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
  } catch {
    return null
  }
}
