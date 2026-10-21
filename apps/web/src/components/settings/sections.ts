import type { DeploymentInfo } from "@/lib/system-api"
import { lazy, type ComponentType } from "react"
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
const TeamSection = lazy(() => import("./sections/team").then((module) => ({ default: module.TeamSection })));
const TEAM: SettingsSection = { id: "team", group: "Worktable", label: "Team", description: "People, invitations and Space access.", icon: UsersRound, component: TeamSection };
const LinksSection = lazy(() =>
  import("./sections/links").then((module) => ({
    default: module.LinksSection,
  }))
)
const AccountSection = lazy(() =>
  import("./sections/account").then((module) => ({
    default: module.AccountSection,
  }))
)
const CloudSection = lazy(() =>
  import("./sections/cloud").then((module) => ({
    default: module.CloudSection,
  }))
)
const GeneralSection = lazy(() =>
  import("./sections/general").then((module) => ({
    default: module.GeneralSection,
  }))
)
const ProfileSection = lazy(() =>
  import("./sections/profile").then((module) => ({
    default: module.ProfileSection,
  }))
)
const AppearanceSection = lazy(() =>
  import("./sections/appearance").then((module) => ({
    default: module.AppearanceSection,
  }))
)
const EditorSection = lazy(() =>
  import("./sections/editor").then((module) => ({
    default: module.EditorSection,
  }))
)
const BackupsSection = lazy(() =>
  import("./sections/backups").then((module) => ({
    default: module.BackupsSection,
  }))
)
const HistorySection = lazy(() =>
  import("./sections/history").then((module) => ({
    default: module.HistorySection,
  }))
)
const AgentsSection = lazy(() =>
  import("./sections/agents").then((module) => ({
    default: module.AgentsSection,
  }))
)
const HelpSection = lazy(() =>
  import("./sections/help").then((module) => ({ default: module.HelpSection }))
)
const SystemSection = lazy(() =>
  import("./sections/system").then((module) => ({
    default: module.SystemSection,
  }))
)
const PortabilitySection = lazy(() =>
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
  component: CloudSection,
}

const ACCOUNT: SettingsSection = {
  id: "account",
  group: "Worktable",
  label: "Subscription",
  description: "Plan and billing.",
  icon: CreditCard,
  component: AccountSection,
}

const LINKS: SettingsSection = {
  id: "links",
  group: "Worktable",
  label: "Links",
  description: "Every share link in this Worktable.",
  icon: Link2,
  component: LinksSection,
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
  component: PortabilitySection,
}

const AGENTS: SettingsSection = {
  id: "agents",
  group: "Worktable",
  label: "Agents",
  description: "Connect agents and manage their access.",
  icon: Bot,
  component: AgentsSection,
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
  component: SystemSection,
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
        component: BackupsSection,
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
