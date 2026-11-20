// A contents worker with readers that misbehave on purpose, for the lane's
// tests (contents-lane.test.ts): each stands for a parser bug the lane must
// end in a stated reason.

import { ReaderRefused, type ParsingReader } from "../contents-protocol.ts"
import { runContentsWorker } from "../contents-worker.ts"

const readers: Record<string, ParsingReader> = {
  echo: {
    version: 1,
    async read(bytes) {
      return {
        parts: [{ label: "All", text: new TextDecoder().decode(bytes) }],
        facts: { bytes: bytes.byteLength, environment: Object.keys(process.env).length },
        gaps: [],
      }
    },
  },
  slow: {
    version: 1,
    async read(bytes) {
      await Bun.sleep(300)
      return { parts: [{ label: "All", text: new TextDecoder().decode(bytes) }], facts: {}, gaps: [] }
    },
  },
  // A parser stuck in a loop that never yields: only a kill stops it.
  hang: {
    version: 1,
    async read() {
      for (;;) {}
    },
  },
  balloon: {
    version: 1,
    async read() {
      const held: Uint8Array[] = []
      for (let i = 0; i < 12; i += 1) held.push(new Uint8Array(32 * 1024 * 1024).fill(1))
      await Bun.sleep(10_000)
      return { parts: [], facts: { held: held.length }, gaps: [] }
    },
  },
  flood: {
    version: 1,
    async read() {
      return { parts: [{ label: "All", text: "x".repeat(4 * 1024 * 1024) }], facts: {}, gaps: [] }
    },
  },
  encrypted: {
    version: 1,
    async read() {
      throw new ReaderRefused("encrypted", "This file is password protected.")
    },
  },
  crash: {
    version: 1,
    async read() {
      process.exit(3)
    },
  },
}

await runContentsWorker(readers)
