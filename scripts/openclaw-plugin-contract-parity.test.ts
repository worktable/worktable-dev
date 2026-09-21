import { describe, expect, test } from "bun:test"
import {
  AGENT_PRESENTATION_HEADERS as hostedHeaders,
  authorizationServerMetadataCandidates as hostedCandidates,
  sameAuthorizationServerIssuer as hostedIssuerEquality,
} from "@worktable/hosted-contract"
import {
  AGENT_PRESENTATION_HEADERS as pluginHeaders,
  authorizationServerMetadataCandidates as pluginCandidates,
  sameAuthorizationServerIssuer as pluginIssuerEquality,
  type AuthorizationServerMetadataName,
} from "../packages/openclaw-plugin/src/worktable-contract"

const issuers = [
  "https://auth.example.test",
  "https://auth.example.test/",
  "https://auth.example.test/issuer",
  "https://auth.example.test/issuer/",
  "https://auth.example.test/tenant/nested/",
]
const metadataNames: AuthorizationServerMetadataName[] = [
  "oauth-authorization-server",
  "openid-configuration",
]

describe("public OpenClaw hosted-contract subset", () => {
  test("keeps presentation headers in parity", () => {
    expect(pluginHeaders).toEqual(hostedHeaders)
  })

  test("keeps issuer comparison in parity", () => {
    for (const left of issuers) {
      for (const right of issuers) {
        expect(pluginIssuerEquality(left, right)).toBe(
          hostedIssuerEquality(left, right)
        )
      }
    }
  })

  test("keeps discovery candidates and ordering in parity", () => {
    for (const issuer of issuers) {
      for (const metadataName of metadataNames) {
        expect(pluginCandidates(issuer, metadataName).map(String)).toEqual(
          hostedCandidates(issuer, metadataName).map(String)
        )
      }
    }
  })
})
