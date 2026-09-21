import { Hono } from "hono"
import { timingSafeEqual } from "node:crypto"
import { isHosted } from "../hosted.ts"
import { LOCAL_PROOF_HEADER } from "../local-host.ts"
import { VERSION } from "../release-info.ts"

const startTime = Date.now()
export const DESKTOP_CONNECTION_PROTOCOL_VERSION = 1

export interface DesktopConnectionHealth {
  protocolVersion: 1
  provider: "selfHosted" | "cloud"
}

export interface HealthResponse {
  ok: true
  service: "worktable"
  version: string
  uptime: number
  desktopConnection: DesktopConnectionHealth
}

export const healthRouter = new Hono()

export function healthPayload(): HealthResponse {
  return {
    ok: true,
    // Stable marker so clients can distinguish a Worktable server from any other
    // process that happens to answer /health with {"ok":true}.
    service: "worktable",
    // The real installed version (stamped by the installer). The update UI polls
    // /health after a restart and compares this to confirm the new build is live.
    version: VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    desktopConnection: {
      protocolVersion: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      provider: isHosted() ? "cloud" : "selfHosted",
    },
  }
}

healthRouter.get("/", (c) => {
  const instanceToken = process.env["WORKTABLE_HOST_INSTANCE_TOKEN"]?.trim()
  if (instanceToken) c.header("X-Worktable-Host-Instance", instanceToken)
  const expectedProof = process.env["WORKTABLE_LOCAL_PROOF_TOKEN"]?.trim()
  const suppliedProof = c.req.header(LOCAL_PROOF_HEADER)?.trim()
  if (expectedProof && suppliedProof) {
    const expected = Buffer.from(expectedProof)
    const supplied = Buffer.from(suppliedProof)
    if (
      expected.length === supplied.length &&
      timingSafeEqual(expected, supplied)
    ) {
      c.header(LOCAL_PROOF_HEADER, "verified")
    }
  }
  return c.json(healthPayload())
})
