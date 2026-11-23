import { createFileRoute } from "@tanstack/react-router"
import { RecentRoute } from "@/components/recent-route"

export const Route = createFileRoute("/recent")({
  ssr: false,
  component: RecentRoute,
})
