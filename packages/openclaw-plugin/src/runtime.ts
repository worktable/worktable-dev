import {
  createPluginRuntimeStore,
  type PluginRuntime,
} from "openclaw/plugin-sdk/runtime-store"

const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "worktable",
  errorMessage: "Worktable plugin runtime is not initialized",
})

export const setWorktableRuntime = runtimeStore.setRuntime
export const getWorktableRuntime = runtimeStore.getRuntime
