// ============================================================
// The server executable's entry
// ============================================================
//
// One executable runs the server and the worker that parses files for their
// contents (contents-worker.ts). Each loads only what it needs: the worker
// starts in a few tens of milliseconds without loading the server, so a
// file is parsed in a process of its own that can be killed.

import { CONTENTS_WORKER_COMMAND } from "./contents-protocol.ts"

if (process.argv[2] === CONTENTS_WORKER_COMMAND) {
  const { runContentsWorker } = await import("./contents-worker.ts")
  await runContentsWorker()
} else {
  const { runServerMain } = await import("./index.ts")
  await runServerMain()
}
