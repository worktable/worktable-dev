import { createFileRoute } from "@tanstack/react-router"
import { FolderRoute } from "@/components/spaces/folder-route"

export const Route = createFileRoute("/spaces/$spaceId/folders/$")({
  ssr: false,
  component: FolderRoute,
})
