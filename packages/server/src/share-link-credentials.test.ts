import { expect, test, spyOn } from "bun:test"
import {
  hashSharePassword,
  SharePasswordBusy,
  mintLegacyFrameTicket,
  legacyFrameToken,
  mintShareTicket,
  shareTicketLinkId,
  supportedSharePasswordHash,
  validShareTicket,
  verifySharePassword,
  verifyShareLinkPassword,
  SharePasswordLimited,
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

test("visitor verification preserves owner capacity and both slots recover", async () => {
  const hash = await hashSharePassword("test-only password")
  let finishVisitor!: (value: boolean) => void
  let finishOwner!: (value: string) => void
  const visitor = spyOn(Bun.password, "verify").mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finishVisitor = resolve
      })
  )
  const owner = spyOn(Bun.password, "hash").mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finishOwner = resolve
      })
  )
  try {
    const verifying = verifySharePassword("visitor", hash)
    const saving = hashSharePassword("owner replacement")
    await expect(
      verifySharePassword("another visitor", hash)
    ).rejects.toBeInstanceOf(SharePasswordBusy)
    await expect(
      hashSharePassword("another owner save")
    ).rejects.toBeInstanceOf(SharePasswordBusy)
    finishVisitor(true)
    finishOwner(hash)
    expect(await Promise.all([verifying, saving])).toEqual([true, hash])
  } finally {
    finishVisitor?.(false)
    finishOwner?.(hash)
    visitor.mockRestore()
    owner.mockRestore()
  }
  expect(await verifySharePassword("test-only password", hash)).toBe(true)
})

test("failed link guesses stop before native verification and recover on expiry or password change", async () => {
  const hash = await hashSharePassword("test-only password")
  const link = { id: crypto.randomUUID(), passwordRevision: 1 }
  const now = Date.now()
  const verify = spyOn(Bun.password, "verify").mockResolvedValue(false)
  try {
    for (let attempt = 0; attempt < 30; attempt++)
      expect(await verifyShareLinkPassword(link, "wrong", hash, now)).toBe(
        false
      )
    await expect(
      verifyShareLinkPassword(link, "wrong", hash, now)
    ).rejects.toBeInstanceOf(SharePasswordLimited)
    expect(verify).toHaveBeenCalledTimes(30)
    verify.mockResolvedValue(true)
    expect(
      await verifyShareLinkPassword(
        { ...link, passwordRevision: 2 },
        "new",
        hash,
        now
      )
    ).toBe(true)
    expect(
      await verifyShareLinkPassword(link, "right", hash, now + 60_000)
    ).toBe(true)
  } finally {
    verify.mockRestore()
  }
})
