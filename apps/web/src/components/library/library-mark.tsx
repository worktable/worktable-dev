import { recognitionColor } from "@worktable/types/recognition"
import { cn } from "@worktable/ui/lib/utils"
import {
  SpaceIcon,
  ThreadParticipantAvatar,
  WorktableTile,
} from "@/components/identity-icons"
import { type LibraryRef } from "@/lib/library"
import { useSpaces, useWorkspace } from "@/lib/queries"
import { tileLogo } from "@/lib/recognition"

/** Whose library it is, drawn as that Worktable, Space or agent is everywhere. */
export function LibraryMark({
  library,
  name,
  className,
}: {
  library: LibraryRef
  name: string
  className?: string
}) {
  const { data: workspace } = useWorkspace()
  const { data: spaces } = useSpaces()
  if (library.kind === "worktable") {
    return (
      <WorktableTile
        name={name}
        color={recognitionColor(workspace?.color, workspace?.id ?? name)}
        logo={tileLogo(workspace?.logo)}
        className={cn("size-5 text-[11px]", className)}
      />
    )
  }
  if (library.kind === "space") {
    const space = spaces?.find((candidate) => candidate.id === library.spaceId)
    return (
      <SpaceIcon
        space={space ?? { id: library.spaceId }}
        className={className}
      />
    )
  }
  return (
    <ThreadParticipantAvatar
      participant={{ kind: "agent", id: library.participantId, name }}
      className={cn("size-5 text-[9px]", className)}
    />
  )
}
