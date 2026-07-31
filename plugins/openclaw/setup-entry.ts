import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core"
import { worktableChannel } from "./src/channel.js"

export default defineSetupPluginEntry(worktableChannel)
