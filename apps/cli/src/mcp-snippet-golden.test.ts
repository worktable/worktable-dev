import { describe, expect, it } from "bun:test";
import {
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  MCP_SNIPPET_CLIENT_IDS,
  mcpClientSnippet,
} from "@worktable/types";
import { createDefaultConfig } from "./config.ts";
import { adapters } from "./mcp.ts";

// Golden contract for `worktable mcp print-config <client>`. These bytes are
// FROZEN — a Worktable install must connect any agent with the exact snippet
// users already paste. The CLI's adapter printConfig now delegates to
// mcpClientSnippet in @worktable/types; this pins the shared generator's output
// to the pre-refactor strings (loopback-no-token, token-in-hand, and the goose
// reachable-without-token guidance) so the refactor can never drift them.

const ENDPOINT = "http://127.0.0.1:7480/mcp";
const TOKEN = "wt_test_token";

const LOOPBACK_NO_TOKEN: Record<string, string> = {
  "claude-code": "claude mcp add --transport http worktable http://127.0.0.1:7480/mcp --scope user",
  codex: '[mcp_servers.worktable]\nurl = "http://127.0.0.1:7480/mcp"',
  cursor: `{
  "mcpServers": {
    "worktable": {
      "url": "http://127.0.0.1:7480/mcp"
    }
  }
}`,
  opencode: `{
  "mcp": {
    "worktable": {
      "type": "remote",
      "url": "http://127.0.0.1:7480/mcp",
      "enabled": true
    }
  }
}`,
  vscode: `{
  "servers": {
    "worktable": {
      "type": "http",
      "url": "http://127.0.0.1:7480/mcp"
    }
  }
}`,
  goose: `{
  "name": "worktable",
  "type": "remote",
  "url": "http://127.0.0.1:7480/mcp",
  "enabled": true
}`,
};

const TOKEN_IN_HAND: Record<string, string> = {
  "claude-code":
    'claude mcp add --transport http worktable http://127.0.0.1:7480/mcp --scope user --header "Authorization: Bearer wt_test_token"',
  codex:
    '[mcp_servers.worktable]\nurl = "http://127.0.0.1:7480/mcp"\nhttp_headers = { Authorization = "Bearer wt_test_token" }',
  cursor: `{
  "mcpServers": {
    "worktable": {
      "url": "http://127.0.0.1:7480/mcp",
      "headers": {
        "Authorization": "Bearer wt_test_token"
      }
    }
  }
}`,
  opencode: `{
  "mcp": {
    "worktable": {
      "type": "remote",
      "url": "http://127.0.0.1:7480/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer wt_test_token"
      }
    }
  }
}`,
  vscode: `{
  "servers": {
    "worktable": {
      "type": "http",
      "url": "http://127.0.0.1:7480/mcp",
      "headers": {
        "Authorization": "Bearer wt_test_token"
      }
    }
  }
}`,
  goose: `{
  "name": "worktable",
  "type": "remote",
  "url": "http://127.0.0.1:7480/mcp",
  "enabled": true,
  "headers": {
    "Authorization": "Bearer wt_test_token"
  }
}`,
};

const REACHABLE_GUIDANCE =
  "# This Worktable endpoint requires a bearer token.\n# Run `worktable mcp print-config goose --with-token` to mint one and embed it.";

describe("mcpClientSnippet golden parity", () => {
  for (const id of MCP_SNIPPET_CLIENT_IDS) {
    it(`${id}: loopback, no token → frozen snippet`, () => {
      const snippet = mcpClientSnippet(id, { endpoint: ENDPOINT });
      expect(snippet.body).toBe(LOOPBACK_NO_TOKEN[id]!);
      expect(snippet.needsToken ?? false).toBe(false);
    });

    it(`${id}: token in hand → frozen snippet with bearer`, () => {
      const snippet = mcpClientSnippet(id, { endpoint: ENDPOINT, token: TOKEN });
      expect(snippet.body).toBe(TOKEN_IN_HAND[id]!);
    });
  }

  it("goose: reachable without a token → the frozen bearer-required guidance", () => {
    const snippet = mcpClientSnippet("goose", {
      endpoint: ENDPOINT,
      reachable: true,
    });
    expect(snippet.body).toBe(REACHABLE_GUIDANCE);
    expect(snippet.needsToken).toBe(true);
  });
});

describe("CLI print-config delegates to the shared snippet", () => {
  // The adapters' printConfig must emit byte-identical output to mcpClientSnippet
  // (its new implementation), proving the CLI wiring stays on the frozen contract.
  const loopback = createDefaultConfig({
    workspace: "/tmp/wt-golden-workspace",
    service: { host: "127.0.0.1", port: 7480, startAtLogin: true },
  });

  for (const id of CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS) {
    it(`${id}: adapter printConfig === frozen loopback snippet`, () => {
      expect(adapters[id].printConfig(loopback)).toBe(LOOPBACK_NO_TOKEN[id]!);
    });

    it(`${id}: adapter printConfig with token === frozen token snippet`, () => {
      expect(adapters[id].printConfig(loopback, TOKEN)).toBe(TOKEN_IN_HAND[id]!);
    });
  }
});
