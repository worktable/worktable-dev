import {
  SCREEN_VIEWS_MAX,
  SCREEN_VIEWS_PATH,
  type AppScreen,
} from "@worktable/types/analytics"
import type { FileRoutesById } from "@/routeTree.gen"
import { authenticatedFetch, BASE_URL } from "./http"

/**
 * Which screens a person moves through on Cloud. Held in memory and sent a
 * few at a time when the tab hides, so moving around the app costs no
 * request; the gateway counts them only for people with analytics on.
 */
const queue: Array<{ screen: AppScreen; at: number }> = []
let shown: AppScreen | null = null
let listening = false
const SEND_AT = 20

export function noteScreen(screen: AppScreen | null): void {
  if (screen === shown) return
  shown = screen
  if (!screen) return
  queue.push({ screen, at: Date.now() })
  if (queue.length >= SEND_AT) sendScreens()
  if (!listening && typeof document !== "undefined") {
    listening = true
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") sendScreens()
    })
    window.addEventListener("pagehide", sendScreens)
  }
}

export function sendScreens(): void {
  if (queue.length === 0) return
  const screens = queue.splice(0, SCREEN_VIEWS_MAX)
  // keepalive lets the send finish as the page closes.
  void authenticatedFetch(`${BASE_URL}${SCREEN_VIEWS_PATH}`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screens }),
  }).catch(() => undefined)
}

/**
 * The screen each route shows, by route ID, never its path. A new route
 * fails the build until it is named here.
 */
const SCREENS: Record<Exclude<keyof FileRoutesById, "__root__">, AppScreen | null> = {
  "/": "home",
  "/activity": "activity",
  "/connect": "connect",
  "/login": null,
  "/spaces/$spaceId": "space",
  "/spaces/$spaceId/docs/$": "doc",
  "/spaces/$spaceId/documents/$": "document",
  "/spaces/$spaceId/records/$": "records",
  "/spaces/$spaceId/records/$collectionId/$recordId": "record",
  "/spaces/$spaceId/threads/$": "space_threads",
  "/spaces/$spaceId/widgets/$": "widget",
  "/threads/$": "threads",
}

export function screenOfRoute(routeId: string | undefined): AppScreen | null {
  return routeId && Object.hasOwn(SCREENS, routeId)
    ? SCREENS[routeId as keyof typeof SCREENS]
    : null
}
