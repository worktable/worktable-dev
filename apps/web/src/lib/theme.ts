import { THEME_SHELL_COLORS } from "@worktable/ui/theme"

export const DEFAULT_THEME = "dark" as const
export const THEME_STORAGE_KEY = "theme"

// Runs in the static shell before React and before the first body paint.
// Storage can be unavailable in private/embedded contexts.
export const themeBootstrapScript = `(()=>{let t="${DEFAULT_THEME}";try{const s=localStorage.getItem("${THEME_STORAGE_KEY}");if(s==="light"||s==="dark"||s==="system")t=s}catch{}if(t==="system")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";const r=document.documentElement;r.classList.remove("light","dark");r.classList.add(t);r.style.colorScheme=t;const m=document.querySelector('meta[name="theme-color"]');if(m)m.content=t==="dark"?"${THEME_SHELL_COLORS.dark}":"${THEME_SHELL_COLORS.light}"})()`
