/**
 * Typing load (Plan 15, W0-04): one headless Yjs client types into a rich
 * document at a steady rate while a second client watches for the echo.
 * Measures request-loop delay (sampled /health latency), server CPU, bytes the
 * server wrote, how often the document file changed, and echo latency.
 *
 * Run through server.ts (`--typing-minutes`), which boots the server.
 */
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { WebsocketProvider } from "y-websocket"
import * as Y from "yjs"
import {
  get,
  healthSampler,
  percentile,
  processCounters,
  round,
} from "./lib.ts"

const MESSAGE_PING = 42
const MESSAGE_INTENT = 43
const INTENT_FRAME = new Uint8Array([MESSAGE_INTENT])

export interface TypingResult {
  minutes: number
  charactersPerSecond: number
  typed: number
  echoed: number
  echoMs: { p50: number | null; p95: number | null; max: number | null }
  healthMs: {
    samples: number
    p50: number | null
    p95: number | null
    max: number | null
  }
  /** Document file changes while typing, and the longest stretch without one. */
  persists: number
  longestUnsavedMs: number | null
  /** From the last keystroke until the file changed (null: no save within 20 s). */
  saveAfterStopMs: number | null
  savedAllText: boolean
  /**
   * Linux only, from /proc/<pid>/io and /proc/<pid>/stat: bytes passed to
   * write calls, bytes that reached the storage layer, and CPU time.
   */
  serverWriteBytes: number | null
  serverDiskBytes: number | null
  serverCpuMs: number | null
}

function lastText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText | null {
  for (let index = node.length - 1; index >= 0; index -= 1) {
    const child = node.get(index)
    if (child instanceof Y.XmlText) return child
    if (child instanceof Y.XmlElement) {
      const found = lastText(child)
      if (found) return found
    }
  }
  return null
}

async function connect(
  url: string,
  room: string,
  params: Record<string, string>
) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(
    `${url.replace(/^http/, "ws")}/yjs`,
    room,
    doc,
    {
      params,
      disableBc: true,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    }
  )
  provider.messageHandlers[MESSAGE_PING] = () => {}
  provider.messageHandlers[MESSAGE_INTENT] = () => {}
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Yjs sync timed out for ${room}`)),
      60_000
    )
    provider.once("sync", () => {
      clearTimeout(timer)
      resolve()
    })
  })
  const text = lastText(doc.getXmlFragment("document-store"))
  if (!text) throw new Error(`no text block in ${room}`)
  return { doc, provider, text }
}

/** The last text run in saved BlockNote JSON, where the typing went. */
function lastSavedText(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = lastSavedText(value[index])
      if (found !== null) return found
    }
    return null
  }
  if (!value || typeof value !== "object") return null
  const node = value as Record<string, unknown>
  if (node["type"] === "text" && typeof node["text"] === "string")
    return node["text"]
  return lastSavedText(node["children"]) ?? lastSavedText(node["content"])
}

export async function runTyping(options: {
  url: string
  pid: number
  workspace: string
  spaceId: string
  path: string
  minutes: number
  charactersPerSecond?: number
}): Promise<TypingResult> {
  const cps = options.charactersPerSecond ?? 5
  const meta = (await (
    await get(
      `${options.url}/api/spaces/${options.spaceId}/docs/${options.path}?conversionCheck=skip`
    )
  ).json()) as { collaborationEpoch: string; collaborationCacheEpoch: string }
  const params = {
    collaborationEpoch: meta.collaborationEpoch,
    collaborationCacheEpoch: meta.collaborationCacheEpoch,
  }
  const room = `${options.spaceId}/${options.path}`
  const writer = await connect(options.url, room, params)
  const reader = await connect(options.url, room, params)
  const baseLength = reader.text.length

  const sentAt: number[] = []
  const echoMs: number[] = []
  reader.doc.on("update", () => {
    const now = performance.now()
    for (
      let index = echoMs.length;
      index < reader.text.length - baseLength && index < sentAt.length;
      index += 1
    ) {
      echoMs.push(now - sentAt[index]!)
    }
  })

  const file = join(
    options.workspace,
    "spaces",
    options.spaceId,
    "docs",
    `${options.path}.json`
  )
  const saves: number[] = []
  let lastMtime = statSync(file).mtimeMs
  const watchFile = setInterval(() => {
    const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs
    if (mtime !== undefined && mtime !== lastMtime) {
      lastMtime = mtime
      saves.push(performance.now())
    }
  }, 50)

  const health = healthSampler(options.url, 250)

  const before = processCounters(options.pid)
  const alphabet = "the quick brown fox jumps over the lazy dog "
  const total = Math.round(options.minutes * 60 * cps)
  const started = performance.now()
  let typed = ""
  for (let index = 0; index < total; index += 1) {
    await Bun.sleep(
      Math.max(0, started + (index * 1000) / cps - performance.now())
    )
    const character = alphabet[index % alphabet.length]!
    sentAt.push(performance.now())
    writer.doc.transact(() => writer.text.insert(writer.text.length, character))
    writer.provider.ws?.send(INTENT_FRAME)
    typed += character
  }
  const typingEnd = performance.now()
  while (
    performance.now() - typingEnd < 20_000 &&
    !saves.some((at) => at > typingEnd)
  ) {
    await Bun.sleep(100)
  }
  const after = processCounters(options.pid)
  const healthMs = await health.stop()
  clearInterval(watchFile)
  writer.provider.destroy()
  reader.provider.destroy()

  const during = saves.filter((at) => at <= typingEnd)
  const marks = [started, ...during, typingEnd]
  const gaps = marks.slice(1).map((at, index) => at - marks[index]!)
  const saveAfterStop = saves.find((at) => at > typingEnd)
  return {
    minutes: options.minutes,
    charactersPerSecond: cps,
    typed: typed.length,
    echoed: echoMs.length,
    echoMs: {
      p50: round(percentile(echoMs, 0.5)),
      p95: round(percentile(echoMs, 0.95)),
      max: round(percentile(echoMs, 1)),
    },
    healthMs: {
      samples: healthMs.length,
      p50: round(percentile(healthMs, 0.5)),
      p95: round(percentile(healthMs, 0.95)),
      max: round(percentile(healthMs, 1)),
    },
    persists: during.length,
    longestUnsavedMs: round(Math.max(...gaps), 0),
    saveAfterStopMs:
      saveAfterStop === undefined ? null : round(saveAfterStop - typingEnd, 0),
    savedAllText:
      lastSavedText(JSON.parse(readFileSync(file, "utf8")))?.endsWith(typed) ??
      false,
    serverWriteBytes:
      before && after ? after.writeBytes - before.writeBytes : null,
    serverDiskBytes:
      before && after ? after.diskBytes - before.diskBytes : null,
    serverCpuMs: before && after ? round(after.cpuMs - before.cpuMs, 0) : null,
  }
}
