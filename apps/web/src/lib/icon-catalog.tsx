import type { ReactNode } from "react"
import { Folder, type LucideProps } from "lucide-react"
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic.mjs"

// Loaded on demand through lib/icons. Names are cheap once this module is
// here; each SVG definition still loads individually when rendered.
export const ALL_ICON_NAMES = [...iconNames].sort()
const knownIcons = new Set<string>(ALL_ICON_NAMES)

export default function CatalogIcon({
  name,
  fallback,
  iconProps,
}: {
  name: string
  fallback: ReactNode
  iconProps: LucideProps
}) {
  if (!knownIcons.has(name)) return fallback
  return (
    <DynamicIcon
      {...iconProps}
      name={name as IconName}
      fallback={() => <Folder {...iconProps} />}
    />
  )
}
