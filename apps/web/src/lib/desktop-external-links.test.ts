import { describe, expect, it } from "bun:test"
import { openExternalLinksThroughDesktop } from "./desktop-external-links"

const LINKS: Record<string, Record<string, string>> = {
  web: { href: "https://example.com/a" },
  mail: { href: "mailto:help@example.com" },
  tab: { href: "https://example.com/b", target: "_blank" },
  doc: { href: "/spaces/s/documents/d" },
}

/** A Worktable page inside Desktop, or in a browser. */
function page({ desktop = true, command = true } = {}) {
  let listener: ((event: MouseEvent) => void) | null = null
  const desktopOpened: string[] = []
  const windowOpened: string[] = []
  const win = {
    open: (url: string) => {
      windowOpened.push(url)
      return null
    },
  }
  const doc = {
    baseURI: "http://127.0.0.1:7481/spaces/s",
    location: { origin: "http://127.0.0.1:7481" },
    documentElement: { hasAttribute: () => desktop },
    defaultView: win,
    addEventListener: (_type: string, handler: (event: MouseEvent) => void) => {
      listener = handler
    },
    removeEventListener: () => {},
  } as unknown as Document
  openExternalLinksThroughDesktop(doc, async (_name, args) => {
    if (!command) throw new Error("command not found")
    desktopOpened.push(String(args?.url))
  })
  const click = (id: string) => {
    const attributes = LINKS[id]!
    const anchor = {
      getAttribute: (name: string) => attributes[name] ?? null,
      hasAttribute: (name: string) => name in attributes,
    }
    let prevented = false
    listener?.({
      button: 0,
      defaultPrevented: false,
      target: { closest: () => anchor },
      preventDefault: () => {
        prevented = true
      },
    } as unknown as MouseEvent)
    return prevented
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { click, open: (url: string) => win.open(url), desktopOpened, windowOpened, settle }
}

describe("links that leave Worktable inside Desktop", () => {
  it("go to Desktop, whether clicked or opened by code", async () => {
    const desktop = page()
    expect(desktop.click("web")).toBe(true)
    expect(desktop.click("mail")).toBe(true)
    expect(desktop.click("tab")).toBe(true)
    expect(desktop.open("https://checkout.example.com/s")).toBeNull()
    await desktop.settle()
    expect(desktop.desktopOpened).toEqual([
      "https://example.com/a",
      "mailto:help@example.com",
      "https://example.com/b",
      "https://checkout.example.com/s",
    ])
    expect(desktop.windowOpened).toEqual([])
  })

  it("leave Worktable links and the browser alone, and fall back without the command", async () => {
    const desktop = page()
    expect(desktop.click("doc")).toBe(false)
    desktop.open("http://127.0.0.1:7481/spaces/s/documents/d")
    expect(desktop.windowOpened).toEqual(["http://127.0.0.1:7481/spaces/s/documents/d"])

    const browser = page({ desktop: false })
    expect(browser.click("web")).toBe(false)

    const older = page({ command: false })
    older.click("web")
    await older.settle()
    expect(older.windowOpened).toEqual(["https://example.com/a"])
  })
})
