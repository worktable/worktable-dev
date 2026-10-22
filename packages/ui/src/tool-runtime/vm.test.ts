import { expect, it } from "bun:test"
import { ToolVm, TOOL_VM_LIMITS } from "./vm.ts"

const initialEnvironment = {
  theme: "dark" as const,
  viewport: { width: 800, height: 600 },
}
const start = (vm: ToolVm, source: string) =>
  vm.start(source, initialEnvironment)

const messages = (values: string[]) => values.map((value) => JSON.parse(value))

it("exposes only guest JavaScript and explicit JSON capabilities", async () => {
  const vm = await ToolVm.create()
  try {
    const [render] = messages(
      start(
        vm,
        `
      const names = ['window','document','self','parent','location','navigator','fetch',
        'XMLHttpRequest','WebSocket','WebTransport','RTCPeerConnection','Worker',
        'importScripts','indexedDB','localStorage','process','Bun','require','__worktableSend'];
      const globals = Object.fromEntries(names.map(name => [name, typeof globalThis[name]]));
      globals.constructor = worktable.ui.render.constructor('return typeof fetch')();
      Object.prototype.__worktableGuestPollution = true;
      worktable.ui.render(globals);
    `
      )
    )
    expect(render.method).toBe("ui.render")
    expect(
      Object.values(render.args[0]).every((value) => value === "undefined")
    ).toBe(true)
    expect(Object.prototype).not.toHaveProperty("__worktableGuestPollution")
  } finally {
    vm.dispose()
  }
})

it("resumes asynchronous reads and actions without sharing host objects", async () => {
  const vm = await ToolVm.create()
  try {
    const [query] = messages(
      start(
        vm,
        `
      const rows = await worktable.records.query('sales', { limit: 5 });
      worktable.ui.on('select', async event => {
        await worktable.state.set('selection', event.value);
      });
      await worktable.ui.render({ tag: 'p', children: [rows[0].name] });
    `
      )
    )
    expect(query).toMatchObject({
      type: "request",
      method: "records.query",
      args: ["sales", { limit: 5 }],
    })
    const [render] = messages(
      vm.receive(
        JSON.stringify({
          type: "response",
          id: query.id,
          ok: true,
          value: { records: [{ name: "October" }] },
        })
      )
    )
    expect(render.args[0]).toEqual({ tag: "p", children: ["October"] })
    expect(
      vm.receive(
        JSON.stringify({
          type: "response",
          id: render.id,
          ok: true,
          value: null,
        })
      )
    ).toEqual([])
    const [state] = messages(
      vm.receive(
        JSON.stringify({
          type: "event",
          action: "select",
          value: { value: "north" },
        })
      )
    )
    expect(state).toMatchObject({
      method: "state.set",
      args: ["selection", "north"],
    })
    expect(
      vm.receive(
        JSON.stringify({
          type: "response",
          id: state.id,
          ok: true,
          value: "north",
        })
      )
    ).toEqual([])
  } finally {
    vm.dispose()
  }
})

it("stops runaway turns, discards their effects, and permits a fresh instance", async () => {
  for (const source of [
    "worktable.ui.render('never committed'); while (true) {}",
    "function again() { Promise.resolve().then(again) }; again()",
    "const retained=[]; while(true) retained.push(new Uint8Array(1024*1024));",
  ]) {
    const vm = await ToolVm.create()
    expect(() => start(vm, source)).toThrow()
    expect(() => vm.receive("{}")).toThrow()
    vm.dispose()
  }
  const fresh = await ToolVm.create()
  try {
    expect(
      messages(start(fresh, "worktable.ui.render('Ready')"))[0].args
    ).toEqual(["Ready"])
  } finally {
    fresh.dispose()
  }
}, 10_000)

it("bounds aggregate binary allocations even when individual allocations fit", async () => {
  const vm = await ToolVm.create()
  try {
    const [render] = messages(
      start(
        vm,
        `
      const retained = [];
      try { for (let i = 0; i < 128; i++) retained.push(new Uint8Array(1024 * 1024)); }
      catch { /* Recover enough space to report the admitted live allocation count. */ }
      const count = retained.length;
      retained.pop();
      worktable.ui.render(count);
    `
      )
    )
    expect(render.args[0]).toBeGreaterThan(0)
    expect(render.args[0]).toBeLessThan(64)
  } finally {
    vm.dispose()
  }
})

it("rejects oversized source and messages and does not load imported modules", async () => {
  const oversized = await ToolVm.create()
  expect(() =>
    start(oversized, " ".repeat(TOOL_VM_LIMITS.sourceCharacters + 1))
  ).toThrow("too large")
  const vm = await ToolVm.create()
  try {
    expect(() =>
      start(vm, "import 'https://synthetic.invalid/escape.js'")
    ).toThrow()
  } finally {
    vm.dispose()
  }
  const outbound = await ToolVm.create()
  try {
    expect(() =>
      start(
        outbound,
        `await worktable.ui.render('x'.repeat(${TOOL_VM_LIMITS.messageCharacters}))`
      )
    ).toThrow()
  } finally {
    outbound.dispose()
  }
})
