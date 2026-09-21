import type { ComponentType, ReactNode } from "react"
import { Folder, FileText } from "lucide-react"
import type { LucideProps } from "lucide-react"
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic.mjs"

// Names are cheap; SVG definitions load individually when rendered. Importing
// lucide's `icons` namespace forces the entire catalog into the startup bundle.
export const ALL_ICON_NAMES = [...iconNames].sort()
const knownIcons = new Set<string>(ALL_ICON_NAMES)
const iconCache = new Map<string, ComponentType<LucideProps>>()

export function getIcon(name: string): ComponentType<LucideProps> | null {
  if (!knownIcons.has(name)) return null
  let component = iconCache.get(name)
  if (!component) {
    component = function NamedIcon(props: LucideProps) {
      return (
        <DynamicIcon
          {...props}
          name={name as IconName}
          fallback={() => <Folder {...props} />}
        />
      )
    }
    iconCache.set(name, component)
  }
  return component
}

/** Resolve a string icon key to a rendered element. Supports any Lucide icon name. */
export function resolveIcon(
  icon: string | undefined,
  className = "size-4"
): ReactNode {
  if (!icon) return <Folder className={className} />

  // Emoji (starts with non-ASCII) — render as Folder icon instead
  if (/^[^\x00-\x7F]/.test(icon)) {
    return <Folder className={className} />
  }

  const IconComponent = getIcon(icon)
  if (IconComponent) {
    return <IconComponent className={className} />
  }

  return <FileText className={className} />
}
