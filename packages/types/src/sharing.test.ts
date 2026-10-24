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

  it("changes only the comment setting a link update names, and nothing else", () => {
    expect(
      UpdateShareLinkInputSchema.parse({ comments: { acceptComments: false } })
    ).toEqual({ comments: { acceptComments: false } })
    // Visitors always see only their own comments, under a name.
    for (const comments of [{ visitorsSee: "all" }, { anonymousAllowed: true }])
      expect(UpdateShareLinkInputSchema.safeParse({ comments }).success).toBe(
        false
      )
  })
})
