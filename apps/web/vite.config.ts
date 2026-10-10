import { randomUUID } from "node:crypto"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { precompressAssets } from "./precompress-assets"
import { sharedIconChunk } from "./shared-icon-chunk"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { THEME_SHELL_COLORS } from "@worktable/ui/theme"
import { browserNotices } from "../../scripts/browser-notices"

const apiPort = process.env.WORKTABLE_API_PORT ?? "7480"
const apiTarget = process.env.WORKTABLE_API_URL ?? `http://localhost:${apiPort}`
const wsTarget = apiTarget.replace(/^http/, "ws")

export const devServerProxy = {
  // Preserve the browser-facing Host so same-origin writes stay same-origin
  // at the API. Vite's string shorthand rewrites Host but retains Origin.
  "/api": { target: apiTarget, changeOrigin: false },
  "/worktable-preview/fonts": { target: apiTarget, changeOrigin: false },
  "/auth": { target: apiTarget, changeOrigin: false },
  "/ws": { target: wsTarget, ws: true },
  "/yjs": { target: wsTarget, ws: true },
}

export const webManifest = {
  name: "Worktable",
  short_name: "Worktable",
  description:
    "AI agent workspace — dashboards, docs, and data your agents can control",
  theme_color: THEME_SHELL_COLORS.dark,
  background_color: THEME_SHELL_COLORS.dark,
  display: "standalone",
  lang: "en",
  start_url: "/",
  scope: "/",
  icons: [
    {
      src: "pwa-64x64.png",
      sizes: "64x64",
      type: "image/png",
    },
    {
      src: "pwa-192x192.png",
      sizes: "192x192",
      type: "image/png",
    },
    {
      src: "pwa-512x512.png",
      sizes: "512x512",
      type: "image/png",
    },
    {
      src: "maskable-icon-512x512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
}

// Installable web app metadata. Worktable has no service worker.
function webAppManifest(): Plugin {
  return {
    name: "worktable-web-app-manifest",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: JSON.stringify(webManifest),
      })
    },
  }
}

// One id per build. The client compiles it in; the server reports the id of
// the build it serves (build-id.txt beside the assets), so an open tab can
// tell when Worktable was updated under it. Release builds use their source
// commit, so the same source gives the same id; other builds get a fresh one.
const buildId =
  process.env["WORKTABLE_BUILD_ID"]?.trim() ||
  process.env["WORKTABLE_PUBLIC_SOURCE_COMMIT"]?.trim() ||
  randomUUID()

function buildIdFile(): Plugin {
  return {
    name: "worktable-build-id",
    apply: "build",
    generateBundle() {
      if (this.environment?.name !== "client") return
      this.emitFile({
        type: "asset",
        fileName: "build-id.txt",
        source: buildId,
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: { __WORKTABLE_BUILD_ID__: JSON.stringify(buildId) },
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks: sharedIconChunk(),
        onlyExplicitManualChunks: true,
      },
    },
  },
  plugins: [
    // TanStack Start must come before react plugin
    tanstackStart({
      spa: {
        enabled: true,
      },
    }),
    react(),
    tailwindcss(),
    browserNotices(),
    buildIdFile(),
    webAppManifest(),
    precompressAssets(),
  ],
  // Keep the dynamic catalog out of the dev prebundle. Otherwise esbuild
  // splits the static icon barrel into thousands of shared chunks, making
  // ordinary named icon imports fetch the entire catalog during startup.
  optimizeDeps: { exclude: ["lucide-react/dynamic.mjs"] },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // ProseMirror and Yjs rely on singletons; a second copy in the module
    // graph breaks the BlockNote editor (seen as dup-ProseMirror in dev).
    dedupe: [
      "@base-ui/react",
      "prosemirror-model",
      "prosemirror-state",
      "prosemirror-view",
      "prosemirror-transform",
      "yjs",
      "y-prosemirror",
    ],
  },
  server: {
    // Extra hostnames the dev server should answer to, e.g. a reverse-proxied domain
    allowedHosts:
      process.env.DEV_ALLOWED_HOSTS?.split(",")
        .map((h) => h.trim())
        .filter(Boolean) ?? [],
    proxy: devServerProxy,
  },
})
