import { z } from "zod"

/**
 * How a Worktable looks in a list of Worktables: its color, and its logo as
 * an icon name or a small image inlined as a data URL. Cloud stores and
 * returns it; the app decides which colors and icons it draws.
 *
 * A value Cloud can't use is dropped rather than refused, so a bad mark never
 * stops the snapshot or heartbeat that carries it.
 */
export const LISTED_MARK_LOGO_MAX_CHARS = 64 * 1024

export const ListedMarkColor = z.string().regex(/^[a-z]{1,20}$/)

export const ListedMarkLogo = z.union([
  z
    .object({
      kind: z.literal("icon"),
      icon: z
        .string()
        .max(64)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image"),
      data: z
        .string()
        .max(LISTED_MARK_LOGO_MAX_CHARS)
        .regex(/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$/),
    })
    .strict(),
])
export type ListedMarkLogo = z.infer<typeof ListedMarkLogo>

export const LISTED_MARK_FIELDS = {
  color: ListedMarkColor.optional().catch(undefined),
  logo: ListedMarkLogo.optional().catch(undefined),
}
