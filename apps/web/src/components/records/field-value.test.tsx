import { describe, expect, it } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { docQueryKeys } from "@/lib/docs-queries"
import { DocumentReferenceScope, FieldValue } from "./field-value"

const column = { key: "source", type: "document", field: { type: "document" } }

function renderWithClient(client: QueryClient, value: unknown, scopedPaths?: string[]) {
  const field = <FieldValue column={column} value={value} spaceId="meta" linksDisabled />
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {scopedPaths ? <DocumentReferenceScope spaceId="meta" paths={scopedPaths}>{field}</DocumentReferenceScope> : field}
    </QueryClientProvider>
  )
}

describe("record document values", () => {
  it("resolves a local scope miss even when the enclosing batch is empty", () => {
    const client = new QueryClient()
    client.setQueryData(docQueryKeys.references("meta", ["missing/source"]), [{
      storedPath: "missing/source",
      resolvedPath: "missing/source",
      title: "Source",
      state: "missing",
    }])

    const html = renderWithClient(client, "missing/source", [])
    expect(html).toContain("missing")
    expect(html).toContain("Source")
  })

  it("passes malformed file values through as invalid instead of string paths", () => {
    const client = new QueryClient()
    client.setQueryData(docQueryKeys.references("meta", [42]), [{
      storedPath: "42",
      resolvedPath: null,
      title: "42",
      state: "invalid",
      error: "must be a document path string",
    }])

    const html = renderWithClient(client, 42)
    expect(html).toContain("invalid")
    expect(html).toContain("must be a document path string")
  })
})
