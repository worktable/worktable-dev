export const THEME_MODES = ["light", "dark"] as const

export type ThemeMode = (typeof THEME_MODES)[number]

type ModeValues<T> = Record<ThemeMode, T>

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
    panel: "oklch(0.978 0.004 250)",
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
    panel: "oklch(0.185 0.006 250)",
    raised: "oklch(0.20 0.007 250)",
    overlay: "oklch(0.21 0.007 250)",
    muted: "oklch(0.22 0.007 250)",
    field: "oklch(1 0 0 / 3.5%)",
    fieldHover: "oklch(1 0 0 / 6%)",
    selected: "oklch(0.285 0.009 250)",
    decorative: "oklch(0.225 0.007 250)",
  },
} as const

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
      borderInput: "oklch(0.30 0.012 250 / 8%)",
      borderInputHover: "oklch(0.30 0.012 250 / 11%)",
      borderChrome: "oklch(0.30 0.012 250 / 5.5%)",
      overlayBorder: "oklch(0.30 0.012 250 / 10%)",
      foreground: "oklch(0.27 0.025 250)",
      readingForeground: "oklch(0.32 0.020 250)",
      mutedForeground: "oklch(0.49 0.018 250)",
      resizeHandle: "oklch(0.49 0.018 250 / 65%)",
      contrastForeground: "oklch(0.99 0 0)",
      secondaryForeground: "oklch(0.32 0.02 250)",
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
      borderInput: "oklch(1 0 0 / 8%)",
      borderInputHover: "oklch(1 0 0 / 12%)",
      borderChrome: "oklch(1 0 0 / 3.5%)",
      overlayBorder: "oklch(1 0 0 / 4.5%)",
      foreground: "oklch(0.86 0.008 250)",
      readingForeground: "oklch(0.82 0.008 250)",
      mutedForeground: "oklch(0.62 0.012 250)",
      resizeHandle: "oklch(0.62 0.012 250 / 60%)",
      contrastForeground: "oklch(0.985 0 0)",
      secondaryForeground: "oklch(0.86 0.008 250)",
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
    light: "#eef1f4",
    dark: "#17191d",
  },
  blockNote: {
    light: {
      editorText: "#2b343d",
      text: "#26313d",
      menu: "#fafbfc",
      subtle: "#e7eaee",
      selectedText: "#26313d",
      selected: "#d9dee4",
      disabledText: "#5f6975",
      shadow: "rgba(38, 49, 61, 0.10)",
      border: "rgba(38, 49, 61, 0.05)",
    },
    dark: {
      editorText: "#c0c5c9",
      text: "#d2d7de",
      menu: "#202329",
      subtle: "#292d33",
      selectedText: "#eef1f4",
      selected: "#343941",
      disabledText: "#858c96",
      shadow: "rgba(0, 0, 0, 0.30)",
      border: "rgba(255, 255, 255, 0.045)",
    },
  },
  mermaid: {
    light: {
      canvas: "#f3f5f7",
      surfaces: ["#eef1f4", "#e7eaee", "#dde1e6", "#d2d7dd"],
      text: "#283440",
      mutedText: "#5f6975",
      border: "#aeb6c0",
      line: "#68727e",
      bronzeText: "#604b34",
    },
    dark: {
      canvas: "#17191d",
      surfaces: ["#202329", "#272b31", "#2f343b", "#383e46"],
      text: "#e1e5ea",
      mutedText: "#aeb5be",
      border: "#59616c",
      line: "#9ba3ad",
      bronzeText: "#d8c5a8",
    },
  },
} as const

export const THEME_SHELL_COLORS = themeConfig.shell
