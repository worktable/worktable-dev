import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import { trustedLocalIdentity } from "./auth.ts"
import { profileRouter } from "./routes/profile.ts"
import { createThread, readThread } from "./thread-store.ts"
import { createToken } from "./token-store.ts"
import { listThreadParticipantsForDisplay } from "./thread-service.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import {
  adoptSignInPhoto,
  participantPhotoHash,
  removeParticipantPhoto,
  setSignInPhotoFetchForTests,
  signInPhotosSettledForTests,
} from "./participant-photos.ts"

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  ),
  (char) => char.charCodeAt(0)
)

let appDir: string
let workspaceDir: string

function app(): Hono {
  const next = new Hono()
  next.use("/api/*", trustedLocalIdentity())
  next.route("/api/profile", profileRouter)
  return next
}

beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), "worktable-profile-app-"))
  workspaceDir = await mkdtemp(join(tmpdir(), "worktable-profile-work-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
})

afterEach(async () => {
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ])
})

describe("profile routes", () => {
  it("updates the human participant used by Threads", async () => {
    const before = await app().fetch(
      new Request("http://localhost/api/profile")
    )
    const owner = (await before.json()) as { id: string; name: string }
    expect(owner).toMatchObject({ name: "Owner" })
    const { thread } = await createThread(
      { kind: "worktable" },
      {
        author: { id: owner.id, kind: "human", name: owner.name },
        recipient: { id: "ptc_profile_agent", kind: "agent", name: "Atlas" },
        body: "Hello",
        idempotencyKey: "profile-rename",
      }
    )

    const updated = await app().fetch(
      new Request("http://localhost/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  Alex  " }),
      })
    )
    expect(updated.status).toBe(200)
    const profile = (await updated.json()) as { id: string; name: string }
    expect(profile).toMatchObject({ name: "Alex" })
    expect(profile.id).toMatch(/^ptc_/)

    const after = await app().fetch(new Request("http://localhost/api/profile"))
    expect(await after.json()).toEqual(profile)
    const { presentations } = await listThreadParticipantsForDisplay()
    expect(presentations[owner.id]).toEqual(profile)
    expect(presentations["local:owner"]).toEqual(profile)

    // Existing threads show the new name, and @Alex reaches the owner there.
    const renamed = await readThread({ kind: "worktable" }, thread.id)
    expect(renamed.members.find((m) => m.id === owner.id)?.name).toBe("Alex")
    expect(
      renamed.identities.find((i) => i.memberId === owner.id && i.default)?.name
    ).toBe("Alex")
    expect(renamed.updatedAt).toBe(thread.updatedAt)
  })

  it("rejects agent credentials and invalid names", async () => {
    const credential = await createToken({
      scopes: ["threads:*"],
      agent: "codex@test",
    })
    const forbidden = await app().fetch(
      new Request("http://localhost/api/profile", {
        headers: { Authorization: `Bearer ${credential.token}` },
      })
    )
    expect(forbidden.status).toBe(403)

    const invalid = await app().fetch(
      new Request("http://localhost/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: " ".repeat(5) }),
      })
    )
    expect(invalid.status).toBe(400)
  })

  it("keeps a person's photo, shows it wherever they appear, and removes it", async () => {
    const credential = await createToken({ scopes: ["threads:*"], agent: "codex@test" })
    const agentPut = await app().fetch(
      new Request("http://localhost/api/profile/photo", {
        method: "PUT",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "image/png" },
        body: PNG,
      })
    )
    expect(agentPut.status).toBe(403)

    const put = await app().fetch(
      new Request("http://localhost/api/profile/photo", {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: PNG,
      })
    )
    expect(put.status).toBe(200)
    const { id, photo } = (await put.json()) as { id: string; photo: string }
    expect((await listThreadParticipantsForDisplay()).presentations[id]?.photo).toBe(photo)

    // An agent that reads Threads sees people's photos too.
    const served = await app().fetch(
      new Request(`http://localhost/api/profile/photos/${id}/${photo}`, {
        headers: { Authorization: `Bearer ${credential.token}` },
      })
    )
    expect(served.status).toBe(200)
    expect(served.headers.get("Cache-Control")).toContain("immutable")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG)

    const removed = await app().fetch(
      new Request("http://localhost/api/profile/photo", { method: "DELETE" })
    )
    expect(await removed.json()).toEqual({ id, photo: null })
    expect((await listThreadParticipantsForDisplay()).presentations[id]?.photo).toBeUndefined()
    expect(
      (await app().fetch(new Request(`http://localhost/api/profile/photos/${id}/${photo}`))).status
    ).toBe(404)
  })

  it("takes a sign-in photo once, until the person chooses or removes one", async () => {
    let fetches = 0
    setSignInPhotoFetchForTests((async () => {
      fetches += 1
      return new Response(PNG, { headers: { "Content-Type": "image/png" } })
    }) as unknown as typeof fetch)
    try {
      const id = "ptc_signin"
      adoptSignInPhoto(id, "https://photos.example/a.png")
      await signInPhotosSettledForTests()
      expect(participantPhotoHash(id)).toMatch(/^[a-f0-9]{32}$/)
      adoptSignInPhoto(id, "https://photos.example/a.png")
      await signInPhotosSettledForTests()
      expect(fetches).toBe(1)

      await removeParticipantPhoto(id, "https://photos.example/a.png")
      adoptSignInPhoto(id, "https://photos.example/a.png")
      await signInPhotosSettledForTests()
      expect(participantPhotoHash(id)).toBeNull()

      // Only an address that can't be read in transit is fetched.
      adoptSignInPhoto("ptc_other", "http://photos.example/b.png")
      await signInPhotosSettledForTests()
      expect(fetches).toBe(1)

      // A dropped connection is tried again on a later page; a redirect off
      // https is not followed.
      let failing = true
      let tries = 0
      setSignInPhotoFetchForTests((async () => {
        tries += 1
        // The connection drops partway through the photo.
        if (failing)
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new TypeError("connection reset"))
              },
            })
          )
        return new Response(null, { status: 302, headers: { Location: "http://photos.example/c.png" } })
      }) as unknown as typeof fetch)
      adoptSignInPhoto("ptc_later", "https://photos.example/c.png")
      await signInPhotosSettledForTests()
      failing = false
      adoptSignInPhoto("ptc_later", "https://photos.example/c.png")
      await signInPhotosSettledForTests()
      expect(tries).toBe(2)
      expect(participantPhotoHash("ptc_later")).toBeNull()
    } finally {
      setSignInPhotoFetchForTests(null)
    }
  })
})
