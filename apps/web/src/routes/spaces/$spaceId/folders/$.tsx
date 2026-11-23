import { createFileRoute } from "@tanstack/react-router"
import { FolderRoutePage } from "@/components/spaces/folder-list"

export const Route = createFileRoute("/spaces/$spaceId/folders/$")({
  ssr: false,
  component: FolderRoutePage,
})
