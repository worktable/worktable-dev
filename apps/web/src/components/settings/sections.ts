import type { ComponentType } from "react"
import type { LucideIcon } from "lucide-react"
import {
  Bot,
  CircleHelp,
  History,
  MonitorCog,
  PackageOpen,
  Palette,
  PencilLine,
  Settings2,
  UserRound,
} from "lucide-react"
import { AccountSection } from "./sections/account"
import { GeneralSection } from "./sections/general"
import { AppearanceSection } from "./sections/appearance"
import { EditorSection } from "./sections/editor"
import { HistorySection } from "./sections/history"
import { AgentsSection } from "./sections/agents"
import { HelpSection } from "./sections/help"
import { SystemSection } from "./sections/system"
import { PortabilitySection } from "./sections/portability"
import type { DeploymentInfo } from "@/lib/system-api"

export type SettingsSectionId =
  | "general"
  | "account"
  | "appearance"
  | "editor"
  | "history"
  | "portability"
  | "agents"
  | "help"
  | "system"

export interface SettingsSection {
  id: SettingsSectionId
  label: string
  /** One-liner under the section title in the content-pane header. */
  description: string
  icon: LucideIcon
  component: ComponentType
}

export const DEFAULT_SETTINGS_SECTION_ID: SettingsSectionId = "general"

const GENERAL: SettingsSection = {
  id: "general",
  label: "General",
  description: "Worktable name, URL, and local folder.",
  icon: Settings2,
  component: GeneralSection,
}

const ACCOUNT: SettingsSection = {
  id: "account",
  label: "Account",
  description: "Subscription and sign-in.",
  icon: UserRound,
  component: AccountSection,
}

const APPEARANCE: SettingsSection = {
  id: "appearance",
  label: "Appearance",
  description: "Theme and display name.",
  icon: Palette,
  component: AppearanceSection,
}

const EDITOR: SettingsSection = {
  id: "editor",
  label: "Editor",
  description: "Writing preferences.",
  icon: PencilLine,
  component: EditorSection,
}

const HISTORY: SettingsSection = {
  id: "history",
  label: "History",
  description: "Choose how long to keep doc versions.",
  icon: History,
  component: HistorySection,
}

const PORTABILITY: SettingsSection = {
  id: "portability",
  label: "Import & Export",
  description: "Move or browse a portable Worktable package.",
  icon: PackageOpen,
  component: PortabilitySection,
}

const AGENTS: SettingsSection = {
  id: "agents",
  label: "Agents",
  description: "Connect agents and manage their access.",
  icon: Bot,
  component: AgentsSection,
}

const HELP: SettingsSection = {
  id: "help",
  label: "Help",
  description: "Support, documentation, and policies.",
  icon: CircleHelp,
  component: HelpSection,
}

const SYSTEM: SettingsSection = {
  id: "system",
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
      ...(capabilities.workspacePortability ? [PORTABILITY] : []),
      AGENTS,
      HELP,
      CLOUD_ABOUT,
    ]
  }
  return [
    ...(capabilities.workspaceName ? [GENERAL] : []),
    APPEARANCE,
    ...(capabilities.editorSettings ? [EDITOR] : []),
    ...(capabilities.historySettings ? [HISTORY] : []),
    ...(capabilities.workspacePortability ? [PORTABILITY] : []),
    AGENTS,
    HELP,
    SYSTEM,
  ]
}
