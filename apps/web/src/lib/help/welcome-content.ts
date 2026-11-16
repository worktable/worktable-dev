/** The welcome's words and pictures, for the person's role. */
import { WELCOME, type WelcomeScreen } from "./registry"
import type { WelcomeRole } from "./welcome"

/** The still picture above each screen's title. */
export type WelcomePicture = "agents" | "space" | "page"

export interface WelcomeContent {
  eyebrow: string
  screens: Array<WelcomeScreen & { picture: WelcomePicture }>
}

// A joiner's first screen is the team's work, and their second is bringing
// their own agents, so their first two pictures swap.
const PICTURES: Record<WelcomeRole, WelcomePicture[]> = {
  owner: ["agents", "space", "page"],
  joiner: ["space", "agents", "page"],
}

export function welcomeContent(role: WelcomeRole, team: string): WelcomeContent {
  const copy = WELCOME[role]
  return {
    eyebrow: copy.eyebrow.replace("{team}", team),
    screens: copy.screens.map((screen, index) => ({
      ...screen,
      picture: PICTURES[role][index]!,
    })),
  }
}
