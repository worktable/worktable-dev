import {
  MERMAID_THEME_CSS,
  MERMAID_THEME_VARIABLES,
} from "./mermaid-theme.generated"

export type WorktableMermaidThemeMode = "light" | "dark"

/** One Mermaid configuration for the editor and public share pages. */
export function getWorktableMermaidConfig(
  themeMode: WorktableMermaidThemeMode
) {
  const isDark = themeMode === "dark"

  return {
    startOnLoad: false,
    theme: "base" as const,
    look: "classic" as const,
    darkMode: isDark,
    logLevel: "fatal" as const,
    securityLevel: "strict" as const,
    // Author HTML in labels may not carry styles: a label could otherwise
    // restyle or cover the surrounding page. Diagram directives cannot loosen
    // the sanitizer or inject theme CSS; cosmetic theme choices stay theirs.
    dompurifyConfig: { FORBID_TAGS: ["style"], FORBID_ATTR: ["style"] },
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "dompurifyConfig",
      "htmlLabels",
      "themeCSS",
    ],
    htmlLabels: true,
    fontFamily: "General Sans, system-ui, sans-serif",
    fontSize: 14,
    themeVariables: MERMAID_THEME_VARIABLES[themeMode],
    themeCSS: MERMAID_THEME_CSS[themeMode],
    flowchart: {
      curve: "linear" as const,
      useMaxWidth: true,
    },
    sequence: {
      mirrorActors: true,
      useMaxWidth: true,
    },
    er: {
      useMaxWidth: true,
    },
    gantt: {
      fontSize: 12,
    },
  }
}
