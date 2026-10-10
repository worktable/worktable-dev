import { lazy, Suspense, type ComponentType, type ReactNode } from "react"
import {
  BookOpen,
  Bookmark,
  Box,
  Brain,
  Briefcase,
  Calendar,
  Camera,
  ChartColumn,
  Code,
  Compass,
  Cpu,
  Database,
  Eye,
  FileText,
  FlaskConical,
  Folder,
  Globe,
  Grid3x3,
  Heart,
  Layers,
  LayoutDashboard,
  Lightbulb,
  MapIcon,
  MessageSquare,
  Music,
  Package,
  Palette,
  PenTool,
  Rocket,
  Search,
  Settings,
  Shield,
  Star,
  Tag,
  Target,
  Trophy,
  Users,
  Wrench,
  Zap,
} from "lucide-react"
import type { LucideProps } from "lucide-react"

// The icons offered before searching, in picker order. Spaces mostly use
// these, so they render at once; any other Lucide name loads the catalog.
const COMMON_ICONS = new Map<string, ComponentType<LucideProps>>([
  ["folder", Folder],
  ["file-text", FileText],
  ["star", Star],
  ["heart", Heart],
  ["bookmark", Bookmark],
  ["target", Target],
  ["zap", Zap],
  ["rocket", Rocket],
  ["lightbulb", Lightbulb],
  ["code", Code],
  ["database", Database],
  ["globe", Globe],
  ["search", Search],
  ["settings", Settings],
  ["users", Users],
  ["briefcase", Briefcase],
  ["calendar", Calendar],
  ["map", MapIcon],
  ["music", Music],
  ["camera", Camera],
  ["shield", Shield],
  ["layers", Layers],
  ["package", Package],
  ["brain", Brain],
  ["palette", Palette],
  ["cpu", Cpu],
  ["eye", Eye],
  ["flask-conical", FlaskConical],
  ["layout-dashboard", LayoutDashboard],
  ["tag", Tag],
  ["bar-chart-3", ChartColumn],
  ["message-square", MessageSquare],
  ["book-open", BookOpen],
  ["pen-tool", PenTool],
  ["compass", Compass],
  ["trophy", Trophy],
  ["wrench", Wrench],
  ["box", Box],
  ["grid-3x3", Grid3x3],
])

export const POPULAR_ICONS = [...COMMON_ICONS.keys()]

/** The full Lucide catalog: every name and a loader per icon (about 44 KB gzip). */
export const loadIconCatalog = () => import("./icon-catalog")
const CatalogIcon = lazy(() =>
  loadIconCatalog().catch(() => ({
    // An icon that cannot load keeps its placeholder, as it always has.
    default: ({ iconProps }: { iconProps: LucideProps }) => (
      <Folder {...iconProps} />
    ),
  }))
)

/**
 * Any Lucide icon by name. Unknown names render `fallback`; a Folder holds
 * the place while the catalog or the icon itself loads.
 */
export function NamedIcon({
  name,
  fallback = null,
  ...props
}: LucideProps & { name: string; fallback?: ReactNode }) {
  const Common = COMMON_ICONS.get(name)
  if (Common) return <Common {...props} />
  return (
    <Suspense fallback={<Folder {...props} />}>
      <CatalogIcon name={name} fallback={fallback} iconProps={props} />
    </Suspense>
  )
}

/** Resolve a string icon key to a rendered element. Supports any Lucide icon name. */
export function resolveIcon(
  icon: string | undefined,
  className = "size-4"
): ReactNode {
  // Emoji (starts with non-ASCII) render as the Folder icon instead
  if (!icon || /^[^\x00-\x7F]/.test(icon)) {
    return <Folder className={className} />
  }
  return (
    <NamedIcon
      name={icon}
      className={className}
      fallback={<FileText className={className} />}
    />
  )
}
