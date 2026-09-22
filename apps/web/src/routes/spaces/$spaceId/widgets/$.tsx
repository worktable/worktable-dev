import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/spaces/$spaceId/widgets/$")({
  ssr: false,
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/spaces/$spaceId/documents/$",
      params: {
        spaceId: params.spaceId,
        _splat: params._splat ?? "",
      },
      search: true,
      hash: true,
      replace: true,
    })
  },
  component: () => null,
})
