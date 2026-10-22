import variant from "@jitl/quickjs-singlefile-browser-release-sync"
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core"
import { TOOL_GUEST_SDK } from "./guest-sdk.ts"
import {
  toolEnvironment,
  TOOL_SOURCE_CHARACTERS,
  type ToolEnvironment,
} from "./protocol.ts"

export const TOOL_VM_LIMITS = Object.freeze({
  sourceCharacters: TOOL_SOURCE_CHARACTERS,
  messageCharacters: 512 * 1024,
  turnCharacters: 2 * 1024 * 1024,
  messagesPerTurn: 64,
  pendingTurns: 40,
  memoryBytes: 32 * 1024 * 1024,
  wasmMemoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  turnMilliseconds: 1000,
  jobsPerTurn: 1024,
})

/** One heap per tool. Callers must also enforce a hard worker watchdog: a VM
 * interrupt cannot preempt every long native operation inside the WASM engine. */
export class ToolVm {
  private readonly context: QuickJSContext
  private readonly pending = new Set<QuickJSHandle>()
  private dispatcher: QuickJSHandle | undefined
  private deadline = 0
  private outgoing: string[] = []
  private outgoingCharacters = 0
  private alive = true

  private constructor(private readonly runtime: QuickJSRuntime) {
    runtime.setMemoryLimit(TOOL_VM_LIMITS.memoryBytes)
    runtime.setMaxStackSize(TOOL_VM_LIMITS.stackBytes)
    runtime.setInterruptHandler(() => performance.now() >= this.deadline)
    // No module loader, host references, filesystem, timers or browser APIs.
    runtime.removeModuleLoader()
    this.context = runtime.newContext()
  }

  static async create(): Promise<ToolVm> {
    // Bound the entire linear memory too: the interpreter allocation limit
    // alone is not a ceiling for every allocation in the prebuilt engine.
    // Each tool also gets its own module, including its backing memory.
    const isolated = newVariant(variant, {
      wasmMemory: new WebAssembly.Memory({
        initial: 256,
        maximum: TOOL_VM_LIMITS.wasmMemoryBytes / 65536,
      }),
    })
    return new ToolVm(
      (await newQuickJSWASMModuleFromVariant(isolated)).newRuntime()
    )
  }

  start(source: string, environment: ToolEnvironment): string[] {
    if (this.dispatcher) throw new Error("The tool has already started.")
    if (source.length > TOOL_VM_LIMITS.sourceCharacters) {
      this.dispose()
      throw new Error("The tool source is too large.")
    }
    return this.turn(() => {
      const send = this.context.newFunction("send", (value) => {
        if (!value || this.context.typeof(value) !== "string")
          throw new Error("A tool message must be a JSON string.")
        const length = this.context.getProp(value, "length")
        let characters: number
        try {
          characters = this.context.getNumber(length)
        } finally {
          length.dispose()
        }
        if (
          characters > TOOL_VM_LIMITS.messageCharacters ||
          this.outgoing.length >= TOOL_VM_LIMITS.messagesPerTurn ||
          this.outgoingCharacters + characters > TOOL_VM_LIMITS.turnCharacters
        )
          throw new Error("The tool sent too much data.")
        // Convert only a primitive string whose length was checked in the VM.
        this.outgoing.push(this.context.getString(value))
        this.outgoingCharacters += characters
      })
      try {
        this.context.setProp(this.context.global, "__worktableSend", send)
      } finally {
        send.dispose()
      }
      const sdk = this.context.evalCode(TOOL_GUEST_SDK, "worktable-sdk.js", {
        type: "global",
      })
      if (sdk.error) {
        sdk.dispose()
        throw new Error("The tool runtime could not start.")
      }
      this.dispatcher = sdk.value
      // Initialize the SDK before any authored statement can observe it.
      const initial = this.context.newString(
        JSON.stringify({
          type: "environment",
          value: toolEnvironment(environment),
        })
      )
      try {
        this.track(
          this.context.callFunction(
            this.dispatcher,
            this.context.undefined,
            initial
          )
        )
      } finally {
        initial.dispose()
      }
      this.track(this.context.evalCode(source, "tool.mjs", { type: "module" }))
    })
  }

  receive(message: string): string[] {
    if (!this.dispatcher) throw new Error("The tool has not started.")
    if (message.length > TOOL_VM_LIMITS.messageCharacters)
      throw new Error("The tool response is too large.")
    return this.turn(() => {
      const input = this.context.newString(message)
      try {
        this.track(
          this.context.callFunction(
            this.dispatcher!,
            this.context.undefined,
            input
          )
        )
      } finally {
        input.dispose()
      }
    })
  }

  private track(result: ReturnType<QuickJSContext["evalCode"]>): void {
    if (result.error) {
      result.dispose()
      throw new Error("The tool stopped because its code failed.")
    }
    if (this.pending.size >= TOOL_VM_LIMITS.pendingTurns) {
      result.dispose()
      throw new Error("The tool has too many unfinished actions.")
    }
    this.pending.add(result.value)
  }

  private turn(run: () => void): string[] {
    if (!this.alive) throw new Error("The tool has stopped.")
    this.deadline = performance.now() + TOOL_VM_LIMITS.turnMilliseconds
    this.outgoing = []
    this.outgoingCharacters = 0
    try {
      run()
      let jobs = 0
      while (this.runtime.hasPendingJob()) {
        if (
          ++jobs > TOOL_VM_LIMITS.jobsPerTurn ||
          performance.now() >= this.deadline
        )
          throw new Error("The tool exceeded its execution limit.")
        const result = this.runtime.executePendingJobs(1)
        const failed = !!result.error
        result.dispose()
        if (failed) throw new Error("The tool stopped because its code failed.")
      }
      for (const handle of this.pending) {
        const state = this.context.getPromiseState(handle)
        if (state.type === "pending") continue
        if (state.type === "rejected") {
          state.error.dispose()
          throw new Error("The tool stopped because an action failed.")
        }
        // Non-promises return the original borrowed handle. Promise result
        // handles are separately owned and must be released as well.
        if (!state.notAPromise) state.value.dispose()
        handle.dispose()
        this.pending.delete(handle)
      }
      return this.outgoing
    } catch (error) {
      // Do not commit queued UI/data effects from a failed execution turn.
      this.outgoing = []
      this.dispose()
      throw error
    } finally {
      this.deadline = 0
    }
  }

  dispose(): void {
    if (!this.alive) return
    this.alive = false
    for (const handle of this.pending) handle.dispose()
    this.pending.clear()
    this.dispatcher?.dispose()
    this.dispatcher = undefined
    this.context.dispose()
    this.runtime.dispose()
  }
}
