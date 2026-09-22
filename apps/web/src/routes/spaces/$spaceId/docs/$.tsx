import {
  createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/spaces/$spaceId/docs/$")({
  ssr: false, // Editor uses browser-only APIs (IndexedDB, WebSocket, Canvas)
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/spaces/$spaceId/documents/$",
      params: {
        spaceId: params.spaceId,
        _splat: (params as Record<string, string>)["_splat"] ?? "",
      },
      search: true,
      hash: true,
      replace: true,
    })
  },
  component: () => null,
})
