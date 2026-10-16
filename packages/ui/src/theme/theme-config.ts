export const THEME_MODES = ["light", "dark"] as const

export type ThemeMode = (typeof THEME_MODES)[number]

type ModeValues<T> = Record<ThemeMode, T>

const OPAQUE_OKLCH = /^oklch\((\d*\.?\d+)\s+(\d*\.?\d+)\s+(\d*\.?\d+)\)$/

/** Opaque `oklch(L C H)` to the nearest sRGB hex, for adapters that need hex. */
export function oklchToHex(color: string): string {
  const match = color.match(OPAQUE_OKLCH)
  if (!match)
    throw new Error(`Expected an opaque OKLCH color, received ${color}`)

  const lightness = Number(match[1])
  const chroma = Number(match[2])
  const hue = (Number(match[3]) * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]

  return `#${linear
    .map((value) => {
      const clamped = Math.max(0, Math.min(1, value))
      const encoded =
        clamped <= 0.0031308
          ? 12.92 * clamped
          : 1.055 * clamped ** (1 / 2.4) - 0.055
      return Math.round(encoded * 255)
        .toString(16)
        .padStart(2, "0")
    })
    .join("")}`
}

const primaryAccent = {
  light: "oklch(0.50 0.245 253)",
  dark: "oklch(0.52 0.225 254)",
} as const satisfies ModeValues<string>

const primaryTextAccent = {
  light: "oklch(0.50 0.245 253)",
  dark: "oklch(0.75 0.135 254)",
} as const satisfies ModeValues<string>

const neutralSurfaces = {
  light: {
    canvas: "oklch(0.955 0.006 250)",
    panel: "oklch(0.968 0.004 250)",
    raised: "oklch(0.985 0.003 250)",
    overlay: "oklch(0.988 0.003 250)",
    muted: "oklch(0.92 0.006 250)",
    field: "oklch(1 0 0 / 34%)",
    fieldHover: "oklch(0.977 0.004 250)",
    selected: "oklch(0.885 0.008 250)",
    decorative: "oklch(0.935 0.006 250)",
  },
  dark: {
    canvas: "oklch(0.165 0.006 250)",
    panel: "oklch(0.182 0.006 250)",
    raised: "oklch(0.195 0.007 250)",
    overlay: "oklch(0.205 0.007 250)",
    muted: "oklch(0.235 0.007 250)",
    field: "oklch(1 0 0 / 3.5%)",
    fieldHover: "oklch(1 0 0 / 6%)",
    selected: "oklch(0.28 0.009 250)",
    decorative: "oklch(0.235 0.007 250)",
  },
} as const

const ink = {
  light: {
    foreground: "oklch(0.27 0.025 250)",
    readingForeground: "oklch(0.32 0.020 250)",
    mutedForeground: "oklch(0.49 0.018 250)",
  },
  dark: {
    foreground: "oklch(0.86 0.008 250)",
    readingForeground: "oklch(0.82 0.008 250)",
    mutedForeground: "oklch(0.62 0.012 250)",
  },
} as const

// Hex adapters for libraries that cannot read CSS variables. Surfaces derive
// from the semantic roles above so third-party chrome cannot drift from them.
const hex = {
  light: {
    canvas: oklchToHex(neutralSurfaces.light.canvas),
    overlay: oklchToHex(neutralSurfaces.light.overlay),
    decorative: oklchToHex(neutralSurfaces.light.decorative),
    selected: oklchToHex(neutralSurfaces.light.selected),
    foreground: oklchToHex(ink.light.foreground),
    readingForeground: oklchToHex(ink.light.readingForeground),
    mutedForeground: oklchToHex(ink.light.mutedForeground),
  },
  dark: {
    canvas: oklchToHex(neutralSurfaces.dark.canvas),
    overlay: oklchToHex(neutralSurfaces.dark.overlay),
    decorative: oklchToHex(neutralSurfaces.dark.decorative),
    selected: oklchToHex(neutralSurfaces.dark.selected),
    foreground: oklchToHex(ink.dark.foreground),
    readingForeground: oklchToHex(ink.dark.readingForeground),
    mutedForeground: oklchToHex(ink.dark.mutedForeground),
  },
}

export const themeConfig = {
  neutralSurfaces,
  brand: {
    // Static brand artwork is intentionally theme-independent. These sRGB
    // values are derived from the light primary/button-face cobalt recipe so
    // favicons, installed app icons, and exported SVGs stay consistent.
    solidBlue: "#0058E8",
    appIconGradient: {
      start: "#0061ED",
      end: "#0054DF",
    },
    appIconMark: "#FFFFFF",
  },
  modes: {
    light: {
      ...neutralSurfaces.light,
      border: "oklch(0.30 0.012 250 / 10%)",
      cardBorder: "oklch(0.30 0.012 250 / 6.5%)",
      borderInput: "oklch(0.30 0.012 250 / 8%)",
      borderInputHover: "oklch(0.30 0.012 250 / 11%)",
      borderChrome: "oklch(0.30 0.012 250 / 5.5%)",
      overlayBorder: "oklch(0.30 0.012 250 / 7.5%)",
      ...ink.light,
      resizeHandle: "oklch(0.49 0.018 250 / 65%)",
      contrastForeground: "oklch(0.99 0 0)",
      secondaryForeground: "oklch(0.32 0.02 250)",
      surfaceHover: "oklch(0.30 0.012 250 / 4%)",
      surfaceInset: "oklch(0.30 0.012 250 / 3%)",
      sidebar: "oklch(0.975 0.004 250 / 56%)",
      sidebarDesktop: "oklch(0.935 0.006 250 / 72%)",
      sidebarForeground: "oklch(0.27 0.025 250)",
      sidebarHover: "oklch(0.30 0.012 250 / 3%)",
      sidebarAccent: "oklch(0.30 0.012 250 / 5.5%)",
      sidebarControl: "oklch(0.30 0.012 250 / 1.75%)",
      sidebarControlBorder: "oklch(0.30 0.012 250 / 3%)",
      sidebarAccentForeground: "oklch(0.30 0.022 250)",
      controlActive: "oklch(0.50 0.245 253 / 14%)",
      scrollbarThumb: "oklch(0.27 0.01 250 / 16%)",
      scrollbarThumbHover: "oklch(0.27 0.01 250 / 24%)",
    },
    dark: {
      ...neutralSurfaces.dark,
      border: "oklch(1 0 0 / 7%)",
      cardBorder: "oklch(1 0 0 / 6%)",
      borderInput: "oklch(1 0 0 / 8%)",
      borderInputHover: "oklch(1 0 0 / 12%)",
      borderChrome: "oklch(1 0 0 / 3.5%)",
      overlayBorder: "oklch(1 0 0 / 4.5%)",
      ...ink.dark,
      resizeHandle: "oklch(0.62 0.012 250 / 60%)",
      contrastForeground: "oklch(0.985 0 0)",
      secondaryForeground: "oklch(0.86 0.008 250)",
      surfaceHover: "oklch(1 0 0 / 4%)",
      surfaceInset: "oklch(1 0 0 / 2.5%)",
      sidebar: "oklch(0.14 0.006 250 / 64%)",
      sidebarDesktop: "oklch(0.135 0.006 250 / 72%)",
      sidebarForeground: "oklch(0.78 0.01 250)",
      sidebarHover: "oklch(1 0 0 / 2.75%)",
      sidebarAccent: "oklch(1 0 0 / 5%)",
      sidebarControl: "oklch(1 0 0 / 1.5%)",
      sidebarControlBorder: "oklch(1 0 0 / 2.5%)",
      sidebarAccentForeground: "oklch(0.80 0.01 250)",
      controlActive: "oklch(0.52 0.225 254 / 22%)",
      scrollbarThumb: "oklch(1 0 0 / 8%)",
      scrollbarThumbHover: "oklch(1 0 0 / 14%)",
    },
  },
  accents: {
    primary: primaryAccent,
    primaryText: primaryTextAccent,
    bronze: {
      light: "oklch(0.67 0.21 48)",
      dark: "oklch(0.72 0.21 52)",
    },
    bronzeInk: {
      light: "oklch(0.49 0.18 40)",
      dark: "oklch(0.80 0.18 55)",
    },
    // Keep the semantic role so technical notation can be retuned later, but
    // use the primary finish directly while both treatments should match.
    technical: primaryAccent,
    technicalInk: primaryTextAccent,
    // Cobalt reserved for noninteractive product illustrations. Opacity
    // modifiers express marker emphasis without borrowing the action role.
    illustration: primaryAccent,
    focusRing: {
      light: "oklch(0.50 0.245 253)",
      dark: "oklch(0.68 0.17 254)",
    },
    primaryGlow: {
      light: "0 0 14px oklch(0.50 0.245 253 / 16%)",
      dark: "0 0 14px oklch(0.52 0.225 254 / 22%)",
    },
  } satisfies Record<string, ModeValues<string>>,
  content: {
    inlineCode: {
      light: {
        surfaceMix: "16%",
      },
      dark: {
        surfaceMix: "18%",
      },
    },
  },
  status: {
    success: {
      light: "oklch(0.72 0.17 142)",
      dark: "oklch(0.72 0.17 142)",
    },
    warning: {
      light: "oklch(0.78 0.15 75)",
      dark: "oklch(0.78 0.15 75)",
    },
    info: {
      light: "oklch(0.511 0.096 186)",
      dark: "oklch(0.511 0.096 186)",
    },
    destructive: {
      light: "oklch(0.55 0.22 25)",
      dark: "oklch(0.65 0.22 28)",
    },
  } satisfies Record<string, ModeValues<string>>,
  charts: {
    light: [
      "oklch(0.42 0.008 250)",
      "oklch(0.50 0.008 250)",
      "oklch(0.58 0.008 250)",
      "oklch(0.66 0.008 250)",
      "oklch(0.74 0.008 250)",
    ],
    dark: [
      "oklch(0.78 0.008 250)",
      "oklch(0.70 0.008 250)",
      "oklch(0.62 0.008 250)",
      "oklch(0.54 0.008 250)",
      "oklch(0.46 0.008 250)",
    ],
  },
  /**
   * Recognition colors tell Worktables, Spaces and people apart. They tint
   * tiles and icons only; they never mark actions (cobalt) or state. `solid`
   * carries white initials at no less than 4.5:1, `ink` draws an icon on its
   * `soft` fill.
   */
  recognition: {
    teal: {
      light: { solid: "oklch(0.50 0.100 190)", ink: "oklch(0.48 0.100 190)", soft: "oklch(0.93 0.035 190)" },
      dark: { solid: "oklch(0.50 0.100 190)", ink: "oklch(0.78 0.100 190)", soft: "oklch(0.30 0.045 190)" },
    },
    sky: {
      light: { solid: "oklch(0.50 0.100 225)", ink: "oklch(0.48 0.100 225)", soft: "oklch(0.93 0.035 225)" },
      dark: { solid: "oklch(0.50 0.100 225)", ink: "oklch(0.78 0.100 225)", soft: "oklch(0.30 0.045 225)" },
    },
    violet: {
      light: { solid: "oklch(0.50 0.130 300)", ink: "oklch(0.48 0.130 300)", soft: "oklch(0.93 0.045 300)" },
      dark: { solid: "oklch(0.50 0.130 300)", ink: "oklch(0.78 0.130 300)", soft: "oklch(0.30 0.059 300)" },
    },
    rose: {
      light: { solid: "oklch(0.50 0.130 350)", ink: "oklch(0.48 0.130 350)", soft: "oklch(0.93 0.045 350)" },
      dark: { solid: "oklch(0.50 0.130 350)", ink: "oklch(0.78 0.130 350)", soft: "oklch(0.30 0.059 350)" },
    },
    orange: {
      light: { solid: "oklch(0.50 0.140 50)", ink: "oklch(0.48 0.140 50)", soft: "oklch(0.93 0.049 50)" },
      dark: { solid: "oklch(0.50 0.140 50)", ink: "oklch(0.78 0.140 50)", soft: "oklch(0.30 0.063 50)" },
    },
    amber: {
      light: { solid: "oklch(0.50 0.130 85)", ink: "oklch(0.48 0.130 85)", soft: "oklch(0.93 0.045 85)" },
      dark: { solid: "oklch(0.50 0.130 85)", ink: "oklch(0.78 0.130 85)", soft: "oklch(0.30 0.059 85)" },
    },
    green: {
      light: { solid: "oklch(0.50 0.120 150)", ink: "oklch(0.48 0.120 150)", soft: "oklch(0.93 0.042 150)" },
      dark: { solid: "oklch(0.50 0.120 150)", ink: "oklch(0.78 0.120 150)", soft: "oklch(0.30 0.054 150)" },
    },
    slate: {
      light: { solid: "oklch(0.50 0.025 250)", ink: "oklch(0.48 0.025 250)", soft: "oklch(0.93 0.009 250)" },
      dark: { solid: "oklch(0.50 0.025 250)", ink: "oklch(0.78 0.025 250)", soft: "oklch(0.30 0.011 250)" },
    },
  } satisfies Record<string, ModeValues<{ solid: string; ink: string; soft: string }>>,
  backdrop: {
    gridSize: 24,
    placement: "bottom-corners",
    fadeWidth: "76%",
    fadeHeight: "68%",
    fadeMidpoint: "46%",
    fadeMidOpacity: "38%",
    fadeTail: "78%",
    fadeTailOpacity: "10%",
    fadeStop: "100%",
    light: {
      lineColor: "oklch(0.34 0.008 250 / 3%)",
      washColor: "oklch(0.82 0.008 250 / 6%)",
    },
    dark: {
      lineColor: "oklch(0.82 0.008 250 / 2.75%)",
      washColor: "oklch(0.26 0.008 250 / 8%)",
    },
  },
  sidebar: {
    itemRadius: "0.6rem",
    spaceForegroundOpacity: "82%",
    itemForegroundOpacity: "70%",
  },
  elevation: {
    light: {
      dialogBackdrop: "oklch(0 0 0 / 4%)",
      dialogBackgroundClip: "border-box",
      navigationSurface: neutralSurfaces.light.canvas,
      navigationBackdrop: "oklch(0.22 0.008 250 / 18%)",
      navigationShadow:
        "-16px 0 40px -22px oklch(0.25 0.018 250 / 30%), -3px 0 10px -5px oklch(0.25 0.018 250 / 12%)",
      floatingShadow:
        "0 8px 24px -14px oklch(0.25 0.018 250 / 18%), 0 2px 6px -3px oklch(0.25 0.018 250 / 7%)",
      dialogShadow:
        "0 20px 56px -30px oklch(0.25 0.018 250 / 20%), 0 4px 12px -8px oklch(0.25 0.018 250 / 8%)",
      drawerShadowTop:
        "0 18px 48px -30px oklch(0.25 0.018 250 / 24%), 0 4px 12px -7px oklch(0.25 0.018 250 / 9%)",
      drawerShadowRight:
        "-18px 0 48px -30px oklch(0.25 0.018 250 / 24%), -4px 0 12px -7px oklch(0.25 0.018 250 / 9%)",
      drawerShadowBottom:
        "0 -18px 48px -30px oklch(0.25 0.018 250 / 24%), 0 -4px 12px -7px oklch(0.25 0.018 250 / 9%)",
      drawerShadowLeft:
        "18px 0 48px -30px oklch(0.25 0.018 250 / 24%), 4px 0 12px -7px oklch(0.25 0.018 250 / 9%)",
    },
    dark: {
      dialogBackdrop: "oklch(0 0 0 / 10%)",
      dialogBackgroundClip: "padding-box",
      navigationSurface: neutralSurfaces.dark.canvas,
      navigationBackdrop: "oklch(0 0 0 / 34%)",
      navigationShadow:
        "-16px 0 42px -22px oklch(0 0 0 / 48%), -3px 0 11px -5px oklch(0 0 0 / 22%)",
      floatingShadow:
        "0 10px 28px -16px oklch(0 0 0 / 32%), 0 2px 7px -3px oklch(0 0 0 / 14%)",
      dialogShadow:
        "0 24px 64px -34px oklch(0 0 0 / 38%), 0 5px 14px -9px oklch(0 0 0 / 17%)",
      drawerShadowTop:
        "0 20px 52px -30px oklch(0 0 0 / 42%), 0 4px 12px -7px oklch(0 0 0 / 18%)",
      drawerShadowRight:
        "-20px 0 52px -30px oklch(0 0 0 / 42%), -4px 0 12px -7px oklch(0 0 0 / 18%)",
      drawerShadowBottom:
        "0 -20px 52px -30px oklch(0 0 0 / 42%), 0 -4px 12px -7px oklch(0 0 0 / 18%)",
      drawerShadowLeft:
        "20px 0 52px -30px oklch(0 0 0 / 42%), 4px 0 12px -7px oklch(0 0 0 / 18%)",
    },
  },
  finishes: {
    primaryButton: "tactile",
    outlineButton: "flat",
    field: "flat",
    fieldShadow: "none",
    outlineButtonShadow: "none",
    outlineButtonImage: "none",
    light: {
      fieldFocusOpacity: "35%",
      primaryFaceTop: "oklch(0.525 0.238 253)",
      primaryFaceBottom: "oklch(0.485 0.238 253)",
      primaryHighlight: "oklch(1 0 0 / 7%)",
      primaryEdge: "oklch(0.38 0.185 253 / 72%)",
      primaryShadow: "oklch(0.25 0.018 250 / 24%)",
      primaryAmbientShadow: "oklch(0.25 0.018 250 / 11%)",
    },
    dark: {
      fieldFocusOpacity: "50%",
      primaryFaceTop: "oklch(0.545 0.218 254)",
      primaryFaceBottom: "oklch(0.505 0.218 254)",
      primaryHighlight: "oklch(1 0 0 / 14%)",
      primaryEdge: "oklch(0.35 0.155 254 / 76%)",
      primaryShadow: "oklch(0 0 0 / 34%)",
      primaryAmbientShadow: "oklch(0 0 0 / 18%)",
    },
  },
  shell: {
    light: hex.light.canvas,
    dark: hex.dark.canvas,
  },
  blockNote: {
    light: {
      editorText: hex.light.readingForeground,
      text: hex.light.foreground,
      menu: hex.light.overlay,
      subtle: hex.light.decorative,
      selectedText: hex.light.foreground,
      selected: hex.light.selected,
      disabledText: hex.light.mutedForeground,
      shadow: "rgba(38, 49, 61, 0.10)",
      border: "rgba(38, 49, 61, 0.05)",
    },
    dark: {
      editorText: hex.dark.readingForeground,
      text: hex.dark.foreground,
      menu: hex.dark.overlay,
      subtle: hex.dark.decorative,
      selectedText: hex.dark.foreground,
      selected: hex.dark.selected,
      disabledText: hex.dark.mutedForeground,
      shadow: "rgba(0, 0, 0, 0.30)",
      border: "rgba(255, 255, 255, 0.045)",
    },
  },
  // Quickdraw canvas and named ink colors; consumed by browser and agent previews.
  drawing: {
    light: {
      id: "light",
      background: hex.light.canvas,
      colors: {
        black: { stroke: "#283440", fill: "#e7eaee", note: "#eee4bb" },
        grey: { stroke: "#6b7683", fill: "#e7eaee", note: "#e2e6eb" },
        "light-violet": { stroke: "#9b79aa", fill: "#eee6f2", note: "#e4d5ea" },
        violet: { stroke: "#80569a", fill: "#e9dfef", note: "#d9c5e4" },
        blue: { stroke: "#4263bd", fill: "#e0e7f5", note: "#cdd9f0" },
        "light-blue": { stroke: "#528aae", fill: "#e1ecf3", note: "#cce0ec" },
        yellow: { stroke: "#a27c32", fill: "#f1e9d5", note: "#eaddb7" },
        orange: { stroke: "#b07142", fill: "#f1e4d8", note: "#e8ceb7" },
        green: { stroke: "#3d8069", fill: "#dfebe5", note: "#c8dfd2" },
        "light-green": { stroke: "#689052", fill: "#e6eddc", note: "#d6e3c5" },
        "light-red": { stroke: "#b77478", fill: "#f1e2e3", note: "#e8ced0" },
        red: { stroke: "#b94e50", fill: "#f0dddd", note: "#e6c3c3" },
      },
      noteText: "#283440",
      selection: "#4263bd",
      selectionFill: "rgba(66, 99, 189, 0.09)",
      handleFill: hex.light.overlay,
      scribble: "#db6065",
      grid: {
        line: {
          minor: "rgba(40, 52, 64, 0.09)",
          major: "rgba(40, 52, 64, 0.17)",
        },
        dot: {
          minor: "rgba(40, 52, 64, 0.17)",
          major: "rgba(40, 52, 64, 0.29)",
        },
      },
    },
    dark: {
      id: "dark",
      background: hex.dark.canvas,
      colors: {
        black: { stroke: "#e1e5ea", fill: "#2f343b", note: "#d8cda7" },
        grey: { stroke: "#a0aab6", fill: "#2b3037", note: "#ced4dc" },
        "light-violet": { stroke: "#c0a1cf", fill: "#39323f", note: "#d5bddf" },
        violet: { stroke: "#b28dc8", fill: "#352c3e", note: "#c5acd4" },
        blue: { stroke: "#8ba5ed", fill: "#293449", note: "#beccec" },
        "light-blue": { stroke: "#8bb8d4", fill: "#293943", note: "#bed7e6" },
        yellow: { stroke: "#d5b779", fill: "#40392c", note: "#dfd0a4" },
        orange: { stroke: "#d4a17d", fill: "#403329", note: "#e0c2a9" },
        green: { stroke: "#86bca4", fill: "#293b33", note: "#b5d2c2" },
        "light-green": { stroke: "#a6c18a", fill: "#333d2b", note: "#cbdab6" },
        "light-red": { stroke: "#d2a0a3", fill: "#403034", note: "#dfbfc1" },
        red: { stroke: "#db9092", fill: "#402c30", note: "#dfb4b5" },
      },
      noteText: "#283440",
      selection: "#8ba5ed",
      selectionFill: "rgba(139, 165, 237, 0.12)",
      handleFill: hex.dark.overlay,
      scribble: "#db6065",
      grid: {
        line: {
          minor: "rgba(225, 229, 234, 0.09)",
          major: "rgba(225, 229, 234, 0.17)",
        },
        dot: {
          minor: "rgba(225, 229, 234, 0.17)",
          major: "rgba(225, 229, 234, 0.29)",
        },
      },
    },
  },
  mermaid: {
    light: {
      canvas: hex.light.canvas,
      surfaces: ["#eef1f4", "#e7eaee", "#dde1e6", "#d2d7dd"],
      text: "#283440",
      mutedText: "#5f6975",
      border: "#aeb6c0",
      line: "#68727e",
      bronzeText: "#604b34",
    },
    dark: {
      canvas: hex.dark.canvas,
      // Node fills keep their contrast steps on the canvas hue and chroma.
      surfaces: [
        oklchToHex("oklch(0.25 0.008 250)"),
        oklchToHex("oklch(0.285 0.008 250)"),
        oklchToHex("oklch(0.32 0.009 250)"),
        oklchToHex("oklch(0.36 0.010 250)"),
      ],
      text: "#e1e5ea",
      mutedText: "#aeb5be",
      border: "#59616c",
      line: "#9ba3ad",
      bronzeText: "#d8c5a8",
    },
  },
} as const

export const THEME_SHELL_COLORS = themeConfig.shell
