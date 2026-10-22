import { ToolVm, TOOL_VM_LIMITS } from "./vm.ts"
import { toolEnvironment, type ToolEnvironment } from "./protocol.ts"

// The worker is trusted code. Authored source is passed exclusively to the VM;
// never to eval, Function, import(), importScripts, or a browser script element.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage: (message: unknown) => void
  close: () => void
}
let vm: ToolVm | undefined
let busy = false

scope.onmessage = (event) => {
  void run(event.data)
}

async function run(input: unknown): Promise<void> {
  try {
    if (!input || typeof input !== "object" || busy)
      throw new Error("Invalid tool turn.")
    const value = input as Record<string, unknown>
    if (!Number.isSafeInteger(value.id) || typeof value.payload !== "string")
      throw new Error("Invalid tool turn.")
    busy = true
    let messages: string[]
    if (
      value.type === "start" &&
      !vm &&
      value.payload.length <= TOOL_VM_LIMITS.sourceCharacters
    ) {
      const environment = toolEnvironment(value.environment as ToolEnvironment)
      vm = await ToolVm.create()
      messages = vm.start(value.payload, environment)
    } else if (
      value.type === "receive" &&
      vm &&
      value.payload.length <= TOOL_VM_LIMITS.messageCharacters
    ) {
      messages = vm.receive(value.payload)
    } else throw new Error("Invalid tool turn.")
    scope.postMessage({ type: "result", id: value.id, messages })
    busy = false
  } catch (error) {
    vm?.dispose()
    scope.postMessage({
      type: "fault",
      message:
        error instanceof Error
          ? error.message.slice(0, 256)
          : "The tool runtime failed.",
    })
    scope.close()
  }
}
