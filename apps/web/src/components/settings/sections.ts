import type { DeploymentInfo } from "@/lib/system-api"
import type { ComponentType } from "react"
import { preloadableComponent } from "@worktable/ui/lib/preloadable-component"
import { GeneralSection } from "./sections/general"
import { ProfileSection } from "./sections/profile"
import { AppearanceSection } from "./sections/appearance"
import { EditorSection } from "./sections/editor"
import { HistorySection } from "./sections/history"
import { HelpSection } from "./sections/help"
import type { LucideIcon } from "lucide-react"
import {
  Bot,
  Archive,
  CircleHelp,
  History,
  Link2,
  MonitorCog,
  PackageOpen,
  Palette,
  PencilLine,
  Settings2,
  CreditCard,
  UserRound,
  UsersRound,
} from "lucide-react"
// Small sections arrive with the dialog. Larger sections can be warmed without
// mounting them or starting their queries, pairing flows, or update checks.
const TeamSection = preloadableComponent<Record<string, never>>(() =>
  import("./sections/team").then((module) => ({ default: module.TeamSection }))
)
const TEAM: SettingsSection = {
  id: "team",
  group: "Worktable",
  label: "Team",
  description: "People, invitations and Space access.",
  icon: UsersRound,
  component: TeamSection.Component,
  preload: TeamSection.preload,
}
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
const BackupsSection = preloadableComponent<Record<string, never>>(() =>
  import("./sections/backups").then((module) => ({
    default: module.BackupsSection,
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
const PortabilitySection = preloadableComponent<Record<string, never>>(() =>
  import("./sections/portability").then((module) => ({
    default: module.PortabilitySection,
  }))
)

export type SettingsSectionId =
  | "profile"
  | "team"
  | "links"
  | "general"
  | "account"
  | "cloud"
  | "appearance"
  | "editor"
  | "history"
  | "backups"
  | "portability"
  | "agents"
  | "help"
  | "system"

export interface SettingsSection {
  id: SettingsSectionId
  /** You: the person's own settings. Worktable: settings for everyone here. */
  group: "You" | "Worktable" | "Support"
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
  description: "Worktable name, URL, and local folder.",
  icon: Settings2,
  component: GeneralSection,
}

const LINK: SettingsSection = {
  id: "cloud",
  group: "Worktable",
  label: "Worktable Cloud",
  description: "AI connections and document sharing.",
  icon: UserRound,
  component: CloudSection.Component,
  preload: CloudSection.preload,
}

const ACCOUNT: SettingsSection = {
  id: "account",
  group: "Worktable",
  label: "Subscription",
  description: "Plan and billing.",
  icon: CreditCard,
  component: AccountSection.Component,
  preload: AccountSection.preload,
}

const LINKS: SettingsSection = {
  id: "links",
  group: "Worktable",
  label: "Links",
  description: "Every share link in this Worktable.",
  icon: Link2,
  component: LinksSection.Component,
  preload: LinksSection.preload,
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

const EDITOR: SettingsSection = {
  id: "editor",
  group: "Worktable",
  label: "Editor",
  description: "Writing preferences.",
  icon: PencilLine,
  component: EditorSection,
}

const HISTORY: SettingsSection = {
  id: "history",
  group: "Worktable",
  label: "History",
  description: "Choose how long to keep doc versions.",
  icon: History,
  component: HistorySection,
}

const PORTABILITY: SettingsSection = {
  id: "portability",
  group: "Worktable",
  label: "Import & Export",
  icon: PackageOpen,
  component: PortabilitySection.Component,
  preload: PortabilitySection.preload,
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
  description: "Worktable name.",
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
  if (deployment.mode === "cloud") {
    return [
      PROFILE,
      APPEARANCE,
      ...(capabilities.workspaceName ? [CLOUD_GENERAL] : []),
      ...(capabilities.cloudAccount ? [ACCOUNT] : []),
      TEAM,
      ...(capabilities.shareLinks ? [LINKS] : []),
      ...(capabilities.editorSettings ? [EDITOR] : []),
      ...(capabilities.historySettings ? [HISTORY] : []),
      {
        id: "backups",
        group: "Worktable",
        label: "Backups",
        description: "",
        icon: Archive,
        component: BackupsSection.Component,
        preload: BackupsSection.preload,
      },
      ...(capabilities.workspacePortability ? [PORTABILITY] : []),
      AGENTS,
      HELP,
      CLOUD_ABOUT,
    ]
  }
  return [
    PROFILE,
    APPEARANCE,
    ...(capabilities.workspaceName ? [GENERAL] : []),
    ...(capabilities.workspaceUrl ? [LINK] : []),
    TEAM,
    ...(capabilities.shareLinks ? [LINKS] : []),
    ...(capabilities.editorSettings ? [EDITOR] : []),
    ...(capabilities.historySettings ? [HISTORY] : []),
    ...(capabilities.workspacePortability ? [PORTABILITY] : []),
    AGENTS,
    HELP,
    SYSTEM,
  ]
}
