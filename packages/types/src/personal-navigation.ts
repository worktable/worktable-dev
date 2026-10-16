import { z } from "zod";

/**
 * One person's own arrangement of the Spaces they can read: their groups,
 * which group each Space sits in, and the Spaces they pinned. It never changes
 * a Space for anyone else.
 */
export const PersonalGroupSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(60),
});

export const PersonalNavigationSchema = z.object({
  /** Advances with every saved change; a write names the revision it read. */
  revision: z.number().int().min(0),
  groups: z.array(PersonalGroupSchema).max(100),
  /** Space id to group id. A Space sits in at most one group. */
  spaceGroups: z.record(z.string().min(1).max(200), z.string().min(1).max(64)),
  /** Pinned Space ids, in the order they were pinned. */
  pins: z.array(z.string().min(1).max(200)).max(500),
});

export type PersonalGroup = z.infer<typeof PersonalGroupSchema>;
export type PersonalNavigation = z.infer<typeof PersonalNavigationSchema>;

export const EMPTY_PERSONAL_NAVIGATION: PersonalNavigation = {
  revision: 0,
  groups: [],
  spaceGroups: {},
  pins: [],
};

/** Why a navigation value is inconsistent, or null when it is sound. */
export function personalNavigationProblem(
  navigation: Pick<PersonalNavigation, "groups" | "spaceGroups" | "pins">
): string | null {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const group of navigation.groups) {
    if (ids.has(group.id)) return "Group ids must be unique";
    ids.add(group.id);
    const name = group.name.trim().toLocaleLowerCase();
    if (names.has(name)) return "Group names must be unique";
    names.add(name);
  }
  for (const groupId of Object.values(navigation.spaceGroups)) {
    if (!ids.has(groupId)) return "A Space is assigned to a group that does not exist";
  }
  if (new Set(navigation.pins).size !== navigation.pins.length) {
    return "A Space is pinned more than once";
  }
  return null;
}
