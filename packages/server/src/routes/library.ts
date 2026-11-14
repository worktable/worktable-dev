import { Hono, type Context, type Next } from "hono"
import { z } from "zod"
import { requireScope } from "../auth.ts"
import { DocumentWriteError } from "../document-write-service.ts"
import { configuredMcpSurface } from "../mcp/surface.ts"
import {
  addToLibrary,
  approveLibraryProposal,
  discardLibraryProposal,
  isPerson,
  LibraryError,
    librarySkillChange,
  listLibraryForPerson,
  removeFromLibrary,
  restoreLibrarySkill,
  saveLibrarySkill,
  updateLibrarySkillDetails,
} from "../skill-libraries.ts"

// Skill libraries, for people. Their changes take effect at once; agents
// propose over MCP and a person approves or discards here.

export const libraryRouter = new Hono()

/** Only a person manages libraries; an agent's changes are proposals. */
async function requirePerson(c: Context, next: Next) {
  const identity = c.get("identity")
  if (!identity || !isPerson(identity)) {
    return c.json({ error: "A person manages skill libraries.", code: "PERSON_REQUIRED" }, 403)
  }
  await next()
}

/** Libraries ride with the preview agent tools until they are released. */
async function requirePreview(c: Context, next: Next) {
  if (configuredMcpSurface() !== "preview") return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  await next()
}

libraryRouter.use("*", requirePreview, requireScope("documents:read"), requirePerson)

const STATUS: Record<LibraryError["code"], 400 | 403 | 404 | 409 | 503> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unreadable: 503,
}

const DOCUMENT_STATUS: Partial<Record<DocumentWriteError["reason"], 400 | 403 | 404>> = {
  "not-found": 404,
  forbidden: 403,
  invalid: 400,
}

async function answer(c: Context, run: () => Promise<unknown>, status: 200 | 201 = 200) {
  try {
    return c.json(await run(), status)
  } catch (error) {
    if (error instanceof LibraryError) {
      return c.json({ error: error.message, code: error.code.toUpperCase() }, STATUS[error.code])
    }
    if (error instanceof DocumentWriteError) {
      return c.json({ error: error.message, code: error.code }, DOCUMENT_STATUS[error.reason] ?? 409)
    }
    throw error
  }
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (parsed.success) return parsed.data
  return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400)
}

const AddSchema = z.strictObject({
  spaceId: z.string().min(1),
  path: z.string().min(1).max(4096).optional(),
  documentId: z.string().min(1).optional(),
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(1000),
  library: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("worktable") }),
    z.strictObject({ kind: z.literal("space"), spaceId: z.string().min(1).optional() }),
    z.strictObject({ kind: z.literal("agent"), participantId: z.string().min(1) }),
  ]),
})

const SaveSchema = z.strictObject({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(1000).optional(),
  /** The Doc's last save the person looked at; a newer one is refused. */
  version: z.string().min(1).optional(),
})

// GET /api/library: the skills in the libraries this person may see.
libraryRouter.get("/", (c) => answer(c, () => listLibraryForPerson(c.get("identity"))))

// POST /api/library: add a Doc. Its current content is saved and goes live.
libraryRouter.post("/", requireScope("documents:write"), async (c) => {
  const input = await body(c, AddSchema)
  if (input instanceof Response) return input
  return answer(c, async () => ({ entry: await addToLibrary(c.get("identity"), input) }), 201)
})

// POST /api/library/:id/save: make the Doc's current content the live version.
libraryRouter.post("/:id/save", requireScope("documents:write"), async (c) => {
  const input = await body(c, SaveSchema)
  if (input instanceof Response) return input
  return answer(c, async () => ({
    entry: await saveLibrarySkill(c.get("identity"), c.req.param("id")!, input),
  }))
})

// GET /api/library/:id/change: what agents get now beside what waits.
libraryRouter.get("/:id/change", (c) =>
  answer(c, () => librarySkillChange(c.get("identity"), c.req.param("id")!))
)

// PATCH /api/library/:id: rename or redescribe a skill.
const DetailsSchema = z
  .strictObject({
    name: z.string().min(1).max(64).optional(),
    description: z.string().max(1000).optional(),
  })
  .refine((input) => input.name !== undefined || input.description !== undefined)

libraryRouter.patch("/:id", requireScope("documents:write"), async (c) => {
  const input = await body(c, DetailsSchema)
  if (input instanceof Response) return input
  return answer(c, async () => ({
    entry: await updateLibrarySkillDetails(c.get("identity"), c.req.param("id")!, input),
  }))
})

// POST /api/library/:id/restore: put a removed skill back.
libraryRouter.post("/:id/restore", requireScope("documents:write"), (c) =>
  answer(c, async () => ({
    entry: await restoreLibrarySkill(c.get("identity"), c.req.param("id")!),
  }))
)

// POST /api/library/:id/approve: an agent's proposal goes live.
// The person names the revision they reviewed, so a proposal changed since
// can't go live in its place.
const ReviewSchema = z.strictObject({ revision: z.number().int().nonnegative() })

libraryRouter.post("/:id/approve", requireScope("documents:write"), async (c) => {
  const input = await body(c, ReviewSchema)
  if (input instanceof Response) return input
  return answer(c, async () => ({
    entry: await approveLibraryProposal(c.get("identity"), c.req.param("id")!, input.revision),
  }))
})

// POST /api/library/:id/discard: drop an agent's proposal.
libraryRouter.post("/:id/discard", requireScope("documents:write"), async (c) => {
  const input = await body(c, ReviewSchema)
  if (input instanceof Response) return input
  return answer(c, () => discardLibraryProposal(c.get("identity"), c.req.param("id")!, input.revision))
})

// DELETE /api/library/:id: remove a skill from its library.
libraryRouter.delete("/:id", requireScope("documents:write"), (c) =>
  answer(c, () => removeFromLibrary(c.get("identity"), c.req.param("id")!))
)
