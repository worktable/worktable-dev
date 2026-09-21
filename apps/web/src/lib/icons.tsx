import type { ReactNode } from "react";
import { icons, Folder, FileText } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** Convert kebab-case icon name to PascalCase (e.g. "flask-conical" → "FlaskConical") */
function kebabToPascal(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Simple LRU cache for resolved icons to avoid repeated lookups */
const iconCache = new Map<string, LucideIcon | null>();

/**
 * Look up any Lucide icon by kebab-case name.
 * Uses the full `icons` export from lucide-react (~1700 icons).
 */
export function getIcon(name: string): LucideIcon | null {
  if (iconCache.has(name)) return iconCache.get(name)!;

  const pascal = kebabToPascal(name);
  const icon = (icons as Record<string, LucideIcon>)[pascal] ?? null;
  iconCache.set(name, icon);
  return icon;
}

/** Resolve a string icon key to a rendered element. Supports any Lucide icon name. */
export function resolveIcon(
  icon: string | undefined,
  className = "size-4",
): ReactNode {
  if (!icon) return <Folder className={className} />;

  // Emoji (starts with non-ASCII) — render as Folder icon instead
  if (/^[^\x00-\x7F]/.test(icon)) {
    return <Folder className={className} />;
  }

  const IconComponent = getIcon(icon);
  if (IconComponent) {
    return <IconComponent className={className} />;
  }

  return <FileText className={className} />;
}
