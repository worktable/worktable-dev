import { z } from "zod"
import { SETUP_ITEM_IDS, type PersonalSetup } from "@worktable/types/setup"

const EvidenceSchema = z.object({
  at: z.string().min(1).max(40),
  spaceId: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(1000).optional(),
})

export const PersonalSetupSchema = z.object({
  audience: z.enum(["solo", "team"]).optional(),
  items: z.partialRecord(z.enum(SETUP_ITEM_IDS), EvidenceSchema),
  hidden: z.boolean().optional(),
  welcomed: z.boolean().optional(),
  watch: z
    .object({
      since: z.string().min(1).max(40),
      space: EvidenceSchema.optional(),
      doc: EvidenceSchema.optional(),
    })
    .optional(),
})

/** A stored setup, or undefined when it is missing or unreadable. */
export function parsePersonalSetup(value: unknown): PersonalSetup | undefined {
  if (value === undefined) return undefined
  const parsed = PersonalSetupSchema.safeParse(value)
  return parsed.success ? (parsed.data as PersonalSetup) : undefined
}
