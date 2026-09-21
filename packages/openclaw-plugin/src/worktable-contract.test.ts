import { describe, expect, test } from "bun:test"
import {
  AGENT_PRESENTATION_HEADERS,
  authorizationServerMetadataCandidates,
  sameAuthorizationServerIssuer,
} from "./worktable-contract"

describe("public Worktable agent contract", () => {
  test("uses the gateway's agent presentation headers", () => {
    expect(AGENT_PRESENTATION_HEADERS).toEqual({
      ADAPTER: "x-worktable-agent-adapter",
      INSTALLATION: "x-worktable-agent-installation",
      LABEL: "x-worktable-agent-label",
      MACHINE: "x-worktable-agent-machine",
    })
  })

  test("normalizes only trailing issuer slashes", () => {
    expect(
      sameAuthorizationServerIssuer(
        "https://auth.example.test/issuer/",
        "https://auth.example.test/issuer"
      )
    ).toBe(true)
    expect(
      sameAuthorizationServerIssuer(
        "https://auth.example.test/issuer",
        "https://auth.example.test/other"
      )
    ).toBe(false)
  })

  test("orders RFC 8414 and OIDC discovery candidates correctly", () => {
    expect(
      authorizationServerMetadataCandidates(
        "https://auth.example.test/issuer/",
        "oauth-authorization-server"
      ).map(String)
    ).toEqual([
      "https://auth.example.test/.well-known/oauth-authorization-server/issuer",
      "https://auth.example.test/issuer/.well-known/oauth-authorization-server",
    ])
    expect(
      authorizationServerMetadataCandidates(
        "https://auth.example.test/issuer/",
        "openid-configuration"
      ).map(String)
    ).toEqual([
      "https://auth.example.test/issuer/.well-known/openid-configuration",
      "https://auth.example.test/.well-known/openid-configuration/issuer",
    ])
  })
})
