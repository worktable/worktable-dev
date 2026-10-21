import { expect, test } from "bun:test"
import {
  hashSharePassword,
  mintLegacyFrameTicket,
  legacyFrameToken,
  mintShareTicket,
  shareTicketLinkId,
  supportedSharePasswordHash,
  validShareTicket,
  verifySharePassword,
} from "./share-link-credentials.ts"

test("tickets are bound to purpose, link, password revision, workspace and expiry", () => {
  const secret = new Uint8Array(32).fill(7)
  const link = {
    id: "lnk_aaaaaaaaaaaaaaaaaaaaaa",
    passwordRevision: 1,
    workspaceEpoch: "first-workspace",
  }
  const now = 1_800_000_000_000
  const made = mintShareTicket(secret, link, "unlock", now + 60_000, now)!
  expect(made.maxAge).toBe(60)
  expect(shareTicketLinkId(made.ticket, "unlock")).toBe(link.id)
  expect(validShareTicket(made.ticket, secret, link, "unlock", now)).toBe(true)
  for (const changed of [
    { ...link, id: "lnk_bbbbbbbbbbbbbbbbbbbbbb" },
    { ...link, passwordRevision: 2 },
    { ...link, workspaceEpoch: "other" },
  ]) {
    expect(validShareTicket(made.ticket, secret, changed, "unlock", now)).toBe(
      false
    )
  }
  expect(validShareTicket(made.ticket, secret, link, "frame", now)).toBe(false)
  expect(
    validShareTicket(
      made.ticket,
      new Uint8Array(32).fill(8),
      link,
      "unlock",
      now
    )
  ).toBe(false)
  expect(
    validShareTicket(made.ticket, secret, link, "unlock", now + 60_000)
  ).toBe(false)
  expect(
    validShareTicket(
      made.ticket.replace(".1.", ".2."),
      secret,
      link,
      "unlock",
      now
    )
  ).toBe(false)
  expect(mintShareTicket(secret, link, "frame", null, now)!.maxAge).toBe(300)
  expect(mintShareTicket(secret, link, "frame", now - 1, now)).toBeNull()
})

test("passwords are salted Argon2id hashes and unsupported encodings fail closed", async () => {
  const password = "test-only visitor password"
  const hash = await hashSharePassword(password)
  expect(supportedSharePasswordHash(hash)).toBe(true)
  expect(hash).not.toContain(password)
  expect(await verifySharePassword(password, hash)).toBe(true)
  expect(await verifySharePassword("wrong password", hash)).toBe(false)
  expect(await verifySharePassword(password, "later-version")).toBe(false)
})

test("pending legacy frames seal bearer tokens and expire independently of them", () => {
  const secret = new Uint8Array(32).fill(7)
  const token = "A".repeat(43)
  const now = 1_800_000_000_000
  const ticket = mintLegacyFrameTicket(secret, token, null, now)!
  expect(ticket).not.toContain(token)
  expect(legacyFrameToken(secret, ticket, now)).toBe(token)
  expect(legacyFrameToken(secret, ticket, now + 300_000)).toBeNull()
  expect(legacyFrameToken(new Uint8Array(32).fill(8), ticket, now)).toBeNull()
  expect(
    legacyFrameToken(secret, ticket.replace("lf1.", "u1."), now)
  ).toBeNull()
  expect(
    legacyFrameToken(
      secret,
      ticket.replace(String(now / 1000 + 300), String(now / 1000 + 301)),
      now
    )
  ).toBeNull()
})
