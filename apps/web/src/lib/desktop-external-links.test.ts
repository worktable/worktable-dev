import { describe, expect, it } from "bun:test"
import { openExternalLinksAsWindows } from "./desktop-external-links"

const LINKS: Record<string, Record<string, string>> = {
  web: { href: "https://example.com/a" },
  mail: { href: "mailto:help@example.com" },
  doc: { href: "/spaces/s/documents/d" },
  tab: { href: "https://example.com/b", target: "_blank" },
}

/** A page with the links above, inside Desktop or a browser. */
function page(desktop: boolean) {
  let listener: ((event: MouseEvent) => void) | null = null
  const opened: string[] = []
  const doc = {
    baseURI: "http://127.0.0.1:7481/spaces/s",
    location: { origin: "http://127.0.0.1:7481" },
    documentElement: { hasAttribute: () => desktop },
    defaultView: { open: (url: string) => void opened.push(url) },
    addEventListener: (_type: string, handler: (event: MouseEvent) => void) => {
      listener = handler
    },
    removeEventListener: () => {},
  } as unknown as Document
  openExternalLinksAsWindows(doc)
  const click = (id: string) => {
    const attributes = LINKS[id]!
    const anchor = {
      getAttribute: (name: string) => attributes[name] ?? null,
      hasAttribute: (name: string) => name in attributes,
    }
    let prevented = false
    listener!({
      button: 0,
      defaultPrevented: false,
      target: { closest: () => anchor },
      preventDefault: () => {
        prevented = true
      },
    } as unknown as MouseEvent)
    return prevented
  }
  return { click, opened }
}

describe("links that leave Worktable inside Desktop", () => {
  it("open as new windows, which Desktop sends to the browser or mail app", () => {
    const { click, opened } = page(true)
    expect(click("web")).toBe(true)
    expect(click("mail")).toBe(true)
    expect(opened).toEqual(["https://example.com/a", "mailto:help@example.com"])
  })

  it("leave Worktable links, new-window links and the browser alone", () => {
    const desktop = page(true)
    expect(desktop.click("doc")).toBe(false)
    expect(desktop.click("tab")).toBe(false)
    expect(desktop.opened).toEqual([])
    const browser = page(false)
    expect(browser.click("web")).toBe(false)
    expect(browser.opened).toEqual([])
  })
})
