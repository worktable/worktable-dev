import type { DeploymentInfo } from "@/lib/system-api"
import type { ComponentType } from "react"
import { preloadableComponent } from "@worktable/ui/lib/preloadable-component"
import { GeneralSection } from "./sections/general"
import { ProfileSection } from "./sections/profile"
import { AppearanceSection } from "./sections/appearance"
import { PrivacySection } from "./sections/privacy"
import { HelpSection } from "./sections/help"
import type { LucideIcon } from "lucide-react"
import {
  Bot,
  CircleHelp,
  CreditCard,
  Database,
  Link2,
  Globe,
  MonitorCog,
  Palette,
  Settings2,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react"
// Small sections arrive with the dialog. Larger sections can be warmed without
// mounting them or starting their queries, pairing flows, or update checks.
const TeamSection = preloadableComponent<Record<string, never>>(() =>
  import("./sections/team").then((module) => ({ default: module.TeamSection }))
)
const LinksSection = preloadableComponent<Record<string, never>>(() =>
  import("./sections/links").then((module) => ({
    default: module.LinksSection,
  }))
)
const AccountSection = preloadableComponent<Record<string, never>>(() =>
  import("./sections/account").then((module) => ({
    default: module.AccountSection,
  }))
)
const CloudSection = preloadableComponent<Record<string, never>>(() =>
  import("./sections/cloud").then((module) => ({
    default: module.CloudSection,
  }))
)
const DataSection = preloadableComponent<Record<string, never>>(() =>
  import("./sections/data").then((module) => ({
    default: module.DataSection,
  }))
)
const AgentsSection = preloadableComponent<Record<string, never>>(() =>
  import("./sections/agents").then((module) => ({
    default: module.AgentsSection,
  }))
)
const SystemSection = preloadableComponent<Record<string, never>>(() =>
  import("./sections/system").then((module) => ({
    default: module.SystemSection,
  }))
)

export type SettingsSectionId =
  | "general"
  | "team"
  | "agents"
  | "sharing"
  | "billing"
  | "remote"
  | "data"
  | "profile"
  | "appearance"
  | "privacy"
  | "help"
  | "system"

/** Nav order. Worktable is shown under the Worktable's own name. */
export const SETTINGS_GROUPS = ["Worktable", "You", "Support"] as const

export interface SettingsSection {
  id: SettingsSectionId
  /** Worktable: settings for everyone here. You: the person's own settings. */
  group: (typeof SETTINGS_GROUPS)[number]
  label: string
  /** One-liner under the section title in the content-pane header. */
  description?: string
  icon: LucideIcon
  component: ComponentType
  /** Download code ahead without mounting a section's effects. */
  preload?: () => Promise<unknown>
}

export const DEFAULT_SETTINGS_SECTION_ID: SettingsSectionId = "general"

const GENERAL: SettingsSection = {
  id: "general",
  group: "Worktable",
  label: "General",
  description: "Worktable name, URL, local folder, and spellcheck.",
  icon: Settings2,
  component: GeneralSection,
}

const TEAM: SettingsSection = {
  id: "team",
  group: "Worktable",
  label: "Team",
  description: "People, invitations and Space access.",
  icon: UsersRound,
  component: TeamSection.Component,
  preload: TeamSection.preload,
}

const AGENTS: SettingsSection = {
  id: "agents",
  group: "Worktable",
  label: "Agents",
  description: "Connect agents and manage their access.",
  icon: Bot,
  component: AgentsSection.Component,
  preload: AgentsSection.preload,
}

const SHARING: SettingsSection = {
  id: "sharing",
  group: "Worktable",
  label: "Sharing",
  description: "Every share link in this Worktable.",
  icon: Link2,
  component: LinksSection.Component,
  preload: LinksSection.preload,
}

const BILLING: SettingsSection = {
  id: "billing",
  group: "Worktable",
  label: "Billing",
  description: "Plan and payment.",
  icon: CreditCard,
  component: AccountSection.Component,
  preload: AccountSection.preload,
}

const REMOTE: SettingsSection = {
  id: "remote",
  group: "Worktable",
  label: "Remote",
  description: "Use this Worktable away from this device.",
  icon: Globe,
  component: CloudSection.Component,
  preload: CloudSection.preload,
}

// The page names its parts (History, Backups, Import & Export).
const DATA: SettingsSection = {
  id: "data",
  group: "Worktable",
  label: "Data",
  icon: Database,
  component: DataSection.Component,
  preload: DataSection.preload,
}

const PROFILE: SettingsSection = {
  id: "profile",
  group: "You",
  label: "Profile",
  description: "How you appear to people and agents.",
  icon: UserRound,
  component: ProfileSection,
}

const APPEARANCE: SettingsSection = {
  id: "appearance",
  group: "You",
  label: "Appearance",
  description: "Theme.",
  icon: Palette,
  component: AppearanceSection,
}

const PRIVACY: SettingsSection = {
  id: "privacy",
  group: "You",
  label: "Privacy",
  icon: ShieldCheck,
  component: PrivacySection,
}

const HELP: SettingsSection = {
  id: "help",
  group: "Support",
  label: "Help",
  description: "Support, documentation, and policies.",
  icon: CircleHelp,
  component: HelpSection,
}

const SYSTEM: SettingsSection = {
  id: "system",
  group: "Support",
  label: "System",
  description: "Version, address, previews, and software updates.",
  icon: MonitorCog,
  component: SystemSection.Component,
  preload: SystemSection.preload,
}

const CLOUD_GENERAL: SettingsSection = {
  ...GENERAL,
  description: "Worktable name and spellcheck.",
}

const CLOUD_ABOUT: SettingsSection = {
  ...SYSTEM,
  label: "About",
  description: "Version and service information.",
}

/** One capability-driven source for desktop nav, mobile tabs, and panels. */
export function getSettingsSections(
  deployment: DeploymentInfo
): SettingsSection[] {
  const { capabilities } = deployment
  const cloud = deployment.mode === "cloud"
  // General and Data each gather several settings; they appear when any of
  // their parts is available here. Cloud always has Backups.
  const general = capabilities.workspaceName || capabilities.editorSettings
  const data =
    cloud || capabilities.historySettings || capabilities.workspacePortability
  return [
    ...(general ? [cloud ? CLOUD_GENERAL : GENERAL] : []),
    TEAM,
    AGENTS,
    ...(capabilities.shareLinks ? [SHARING] : []),
    ...(cloud && capabilities.cloudAccount ? [BILLING] : []),
    ...(!cloud && capabilities.workspaceUrl ? [REMOTE] : []),
    ...(data ? [DATA] : []),
    PROFILE,
    APPEARANCE,
    ...(cloud && capabilities.analyticsChoice ? [PRIVACY] : []),
    HELP,
    cloud ? CLOUD_ABOUT : SYSTEM,
  ]
}
