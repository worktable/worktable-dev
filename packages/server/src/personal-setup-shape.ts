import { z } from "zod"
import { SETUP_ITEM_IDS, type PersonalSetup } from "@worktable/types/setup"

const EvidenceSchema = z.object({
  at: z.string().min(1).max(40),
  spaceId: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(1000).optional(),
})

const ITEM_IDS = new Set<string>(SETUP_ITEM_IDS)

export const PersonalSetupSchema = z.object({
  // Items a later version no longer lists are dropped, not fatal.
  items: z.preprocess(
    (value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(([id]) => ITEM_IDS.has(id))
          )
        : value,
    z.partialRecord(z.enum(SETUP_ITEM_IDS), EvidenceSchema)
  ),
  hidden: z.boolean().optional(),
  welcomed: z.boolean().optional(),
})

/** A stored setup, or undefined when it is missing or unreadable. */
export function parsePersonalSetup(value: unknown): PersonalSetup | undefined {
  if (value === undefined) return undefined
  const parsed = PersonalSetupSchema.safeParse(value)
  return parsed.success ? (parsed.data as PersonalSetup) : undefined
}
