import { describe, expect, it } from "bun:test"
import {
  defaultSharingPolicy,
  SharingPolicyInputSchema,
  SharingPolicySchema,
  UpdateShareLinkInputSchema,
} from "./sharing"

describe("sharing inputs never reset what they omit", () => {
  it("takes a whole owner policy, and reads a stored one with defaults", () => {
    expect(SharingPolicyInputSchema.safeParse({ paused: true }).success).toBe(
      false
    )
    const policy = { ...defaultSharingPolicy(), paused: true }
    expect(SharingPolicyInputSchema.parse(policy)).toEqual(policy)
    expect(SharingPolicySchema.parse({ paused: true })).toEqual(policy)
  })

  it("changes only the comment settings a link update names", () => {
    expect(
      UpdateShareLinkInputSchema.parse({ comments: { visitorsSee: "all" } })
    ).toEqual({ comments: { visitorsSee: "all" } })
  })
})
