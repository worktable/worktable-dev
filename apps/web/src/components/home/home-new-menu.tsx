import { lazy, Suspense, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { FileText, FolderPlus, MessageCircle, Pencil, Plus } from "lucide-react"
import type { SpaceFile } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { toast } from "@worktable/ui/components/sonner"
import { useNewDocIn } from "@/hooks/use-new-doc"
import { createSpace } from "@/lib/api"
import { resolveIcon } from "@/lib/icons"
import { useNewDocumentLifetime } from "@/lib/lifetime"
import { queryKeys, useWorkspace } from "@/lib/queries"

const NewDrawingDialog = lazy(() =>
  import("@/components/new-drawing-dialog").then((module) => ({
    default: module.NewDrawingDialog,
  }))
)
const NewSpaceDialog = lazy(() =>
  import("@/components/spaces/new-space-dialog").then((module) => ({
    default: module.NewSpaceDialog,
  }))
)

function SpaceChoices({
  spaces,
  onChoose,
}: {
  spaces: SpaceFile[]
  onChoose: (spaceId: string) => void
}) {
  return (
    <DropdownMenuSubContent className="max-h-80 min-w-48 overflow-y-auto">
      {spaces.map((space) => (
        <DropdownMenuItem key={space.id} onClick={() => onChoose(space.id)}>
          {resolveIcon(space.icon, "mr-2 size-4")}
          {space.name}
        </DropdownMenuItem>
      ))}
    </DropdownMenuSubContent>
  )
}

/**
 * Home's New menu. Docs and drawings ask which Space they belong in, listing
 * the most recently active Space first.
 */
export function HomeNewMenu({ spaces }: { spaces: SpaceFile[] }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: workspace } = useWorkspace()
  const [lifetime] = useNewDocumentLifetime()
  const newDocIn = useNewDocIn()
  const [drawingSpaceId, setDrawingSpaceId] = useState<string | null>(null)
  const [spaceOpen, setSpaceOpen] = useState(false)

  const handleCreateSpace = async (data: {
    name: string
    icon?: string
    group?: string
  }) => {
    try {
      const { spaceId } = await createSpace(data)
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
      void navigate({ to: "/spaces/$spaceId", params: { spaceId } })
    } catch (err) {
      toast.error("Failed to create space")
      console.error("Failed to create space:", err)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm">
              <Plus className="size-4" />
              New
            </Button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-48">
          {spaces.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FileText className="mr-2 size-4" />
                Doc
              </DropdownMenuSubTrigger>
              <SpaceChoices
                spaces={spaces}
                onChoose={(spaceId) => newDocIn(spaceId)}
              />
            </DropdownMenuSub>
          )}
          {spaces.length > 0 && workspace?.storageVersion === 2 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Pencil className="mr-2 size-4" />
                Drawing
              </DropdownMenuSubTrigger>
              <SpaceChoices spaces={spaces} onChoose={setDrawingSpaceId} />
            </DropdownMenuSub>
          )}
          <DropdownMenuItem
            onClick={() =>
              void navigate({
                to: "/threads/$",
                params: { _splat: "" },
                search: { location: "all" },
              })
            }
          >
            <MessageCircle className="mr-2 size-4" />
            Thread
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setSpaceOpen(true)}>
            <FolderPlus className="mr-2 size-4" />
            Space
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {drawingSpaceId && (
        <Suspense fallback={null}>
          <NewDrawingDialog
            spaceId={drawingSpaceId}
            lifetime={lifetime}
            onClose={() => setDrawingSpaceId(null)}
            onCreated={() => undefined}
          />
        </Suspense>
      )}
      <DeferredMount active={spaceOpen}>
        <Suspense fallback={null}>
          <NewSpaceDialog
            open={spaceOpen}
            onClose={() => setSpaceOpen(false)}
            onCreate={handleCreateSpace}
          />
        </Suspense>
      </DeferredMount>
    </>
  )
}
