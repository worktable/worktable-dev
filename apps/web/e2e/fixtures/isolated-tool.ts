import { startIsolatedTool } from "../../../../packages/ui/src/tool-runtime/controller.ts"

const source = JSON.parse(
  document.querySelector("#tool-source")!.textContent!
) as string
const workerSource = JSON.parse(
  document.querySelector("#tool-worker")!.textContent!
) as string
const root = document.querySelector<HTMLElement>("#tool")!
const testState = {
  state: {} as Record<string, unknown>,
  queries: 0,
  subscribers: 0,
  closed: false,
  fault: "",
}
const host = startIsolatedTool({
  root,
  source,
  workerSource,
  broker: {
    request: async (method, args) => {
      if (method === "records.query") {
        testState.queries++
        return {
          records: [
            { data: { name: "Équipe 東京 <img src=//outside.invalid>" } },
          ],
        }
      }
      if (method === "state.get")
        return typeof args[0] === "string"
          ? testState.state[args[0]]
          : testState.state
      if (method === "state.set") {
        if (typeof args[0] === "string") testState.state[args[0]] = args[1]
        else Object.assign(testState.state, args[0])
        return testState.state
      }
      throw new Error("This operation is not granted.")
    },
    subscribe: (_collection, _query, changed) => {
      testState.subscribers++
      changed({ records: [{ data: { name: "Live data" } }] })
      return () => {
        testState.subscribers--
      }
    },
  },
  fault: (detail) => {
    testState.fault = detail ?? "Unknown runtime failure"
    console.error("Isolated tool stopped:", testState.fault)
    testState.closed = true
    const heading = document.createElement("h1")
    heading.textContent = "This tool stopped"
    root.replaceChildren(heading)
  },
})
host.environment({
  theme: "dark",
  viewport: { width: innerWidth, height: innerHeight },
})
window.addEventListener("pagehide", () => host.close(), { once: true })
Object.assign(window, { toolTest: { state: testState, close: host.close } })
