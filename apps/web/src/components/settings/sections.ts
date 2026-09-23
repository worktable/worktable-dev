import type { DeploymentInfo } from "@/lib/system-api"
import { lazy, type ComponentType } from "react"
import type { LucideIcon } from "lucide-react"
import {
  Bot,
  Archive,
  CircleHelp,
  History,
  MonitorCog,
  PackageOpen,
  Palette,
  PencilLine,
  Settings2,
  UserRound,
} from "lucide-react"
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
  group: "Workspace" | "Preferences" | "Data" | "Support"
  label: string
  /** One-liner under the section title in the content-pane header. */
  description?: string
  icon: LucideIcon
  component: ComponentType
}

export const DEFAULT_SETTINGS_SECTION_ID: SettingsSectionId = "general"

const GENERAL: SettingsSection = {
  id: "general",
  group: "Workspace",
  label: "General",
  description: "Worktable name, URL, and local folder.",
  icon: Settings2,
  component: GeneralSection,
}

const ACCOUNT: SettingsSection = {
  id: "account",
  group: "Workspace",
  label: "Account",
  description: "Subscription and sign-in.",
  icon: UserRound,
  component: AccountSection,
}

const APPEARANCE: SettingsSection = {
  id: "appearance",
  group: "Preferences",
  label: "Appearance",
  description: "Theme and display name.",
  icon: Palette,
  component: AppearanceSection,
}

const EDITOR: SettingsSection = {
  id: "editor",
  group: "Preferences",
  label: "Editor",
  description: "Writing preferences.",
  icon: PencilLine,
  component: EditorSection,
}

const HISTORY: SettingsSection = {
  id: "history",
  group: "Data",
  label: "History",
  description: "Choose how long to keep doc versions.",
  icon: History,
  component: HistorySection,
}

const PORTABILITY: SettingsSection = {
  id: "portability",
  group: "Data",
  label: "Import & Export",
  icon: PackageOpen,
  component: PortabilitySection,
}

const AGENTS: SettingsSection = {
  id: "agents",
  group: "Workspace",
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
  description: "Version, address, and software updates.",
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
      ...(capabilities.workspaceName ? [CLOUD_GENERAL] : []),
      ...(capabilities.cloudAccount ? [ACCOUNT] : []),
      APPEARANCE,
      ...(capabilities.editorSettings ? [EDITOR] : []),
      ...(capabilities.historySettings ? [HISTORY] : []),
      {
        id: "backups",
        group: "Data",
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
    ...(capabilities.workspaceName ? [GENERAL] : []),
    {
      id: "cloud",
      group: "Workspace",
      label: "Worktable Cloud",
      description: "AI connections and document sharing.",
      icon: UserRound,
      component: CloudSection,
    },
    APPEARANCE,
    ...(capabilities.editorSettings ? [EDITOR] : []),
    ...(capabilities.historySettings ? [HISTORY] : []),
    ...(capabilities.workspacePortability ? [PORTABILITY] : []),
    AGENTS,
    HELP,
    SYSTEM,
  ]
}
