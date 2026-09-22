import { expect, it } from "bun:test"
import { createElement, Suspense, type ComponentType } from "react"
import { renderToString } from "react-dom/server"
import { preloadableComponent } from "./preloadable-component"

const Content = ({ text }: { text: string }) => createElement("p", null, text)
const render = (Component: ComponentType<{ text: string }>) =>
  renderToString(
    createElement(
      Suspense,
      { fallback: createElement("div", null, "Pending code") },
      createElement(Component, { text: "Ready content" })
    )
  )

it("renders completed preloads synchronously through a real Suspense boundary", async () => {
  const loaded = preloadableComponent(async () => ({ default: Content }))
  await loaded.preload()
  const html = render(loaded.Component)
  expect(html).toContain("Ready content")
  expect(html).not.toContain("Pending code")
})

it("retains the fallback while code is still loading", async () => {
  let resolve!: (module: { default: typeof Content }) => void
  const pending = new Promise<{ default: typeof Content }>((done) => { resolve = done })
  const loaded = preloadableComponent(() => pending)
  expect(render(loaded.Component)).toContain("Pending code")
  resolve({ default: Content })
  await loaded.preload()
  expect(render(loaded.Component)).toContain("Ready content")
})

it("shares concurrent preloads and can retry a failed speculative preload", async () => {
  let attempts = 0
  const loaded = preloadableComponent(async () => {
    if (++attempts === 1) throw new Error("Temporary network failure")
    return { default: Content }
  })
  const first = loaded.preload()
  expect(loaded.preload()).toBe(first)
  await expect(first).rejects.toThrow("Temporary network failure")
  await loaded.preload()
  expect(attempts).toBe(2)
  expect(render(loaded.Component)).toContain("Ready content")
})
