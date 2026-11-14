import { useQuery } from "@tanstack/react-query"
import { Library as LibraryIcon } from "lucide-react"
import { useState } from "react"
import { skillNameFrom } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { useIsMobile } from "@/hooks/use-mobile"
import { listAgentConnections } from "@/lib/agent-connections-api"
import { type LibraryRef } from "@/lib/library"
import {
  useLibraryActions,
  type AddToLibraryInput,
} from "@/lib/library-actions"
import { useSpaces, useWorkspace } from "@/lib/queries"
import { getConnection } from "@/lib/system-api"

/**
 * The agents a person can give a library to, by participant, from the same
 * queries Settings → Agents reads.
 */
function useLibraryAgents(): Array<{ participantId: string; name: string }> {
  const connection = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
  })
  const workspaceAgentsOnCloud = connection.data?.mcpAuthMode === "oauth"
  const connections = useQuery({
    queryKey: ["agent-connections", workspaceAgentsOnCloud],
    queryFn: () => listAgentConnections({ workspaceAgentsOnCloud }),
    enabled: connection.isFetched,
  })
  const agents = new Map<string, string>()
  for (const agent of connections.data?.connections ?? []) {
    if (agent.participant && agent.canManage !== false) {
      agents.set(agent.participant.id, agent.displayName)
    }
  }
  return [...agents].map(([participantId, name]) => ({ participantId, name }))
}

const WORKTABLE = "worktable"
const SPACE = "space"
const AGENT = "agent:"

/** Add a Doc to a library: the Worktable's, its Space's, or an agent's. */
export function AddToLibraryDialog({
  spaceId,
  docPath,
  title,
  library: offered,
  onClose,
}: {
  spaceId: string
  docPath: string
  title: string
  /** The library offered first; the Doc's own Space otherwise. */
  library?: LibraryRef
  onClose: () => void
}) {
  const isMobile = useIsMobile()
  const { data: spaces } = useSpaces()
  const spaceName = spaces?.find((space) => space.id === spaceId)?.name
  const agents = useLibraryAgents()
  const { add } = useLibraryActions()
  const { data: workspace } = useWorkspace()
  // The Doc's own Space is the narrowest library, so it is the one offered first.
  const [library, setLibrary] = useState(
    offered?.kind === "worktable"
      ? WORKTABLE
      : offered?.kind === "agent"
        ? AGENT + offered.participantId
        : SPACE
  )
  const [name, setName] = useState(() => skillNameFrom(title))
  const [description, setDescription] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = name.trim() !== "" && description.trim() !== ""

  const labelOf = (value: string) =>
    value === WORKTABLE
      ? (workspace?.name ?? "This Worktable")
      : value === SPACE
        ? (spaceName ?? "This Space")
        : (agents.find((agent) => AGENT + agent.participantId === value)
            ?.name ?? "Agent")

  const submit = async () => {
    if (pending || !ready) return
    const target: AddToLibraryInput["library"] =
      library === WORKTABLE
        ? { kind: "worktable" }
        : library === SPACE
          ? { kind: "space", spaceId }
          : { kind: "agent", participantId: library.slice(AGENT.length) }
    setPending(true)
    setError(null)
    const refused = await add({
      spaceId,
      path: docPath,
      name: name.trim(),
      description: description.trim(),
      library: target,
    })
    setPending(false)
    if (refused) setError(refused)
    else onClose()
  }
  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") void submit()
  }

  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <LibraryIcon className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>Add to Library</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="library-target"
                className="block text-sm font-medium"
              >
                Library
              </label>
              <Select
                value={library}
                onValueChange={(value) => {
                  setLibrary(String(value ?? WORKTABLE))
                  setError(null)
                }}
              >
                <SelectTrigger id="library-target" className="w-full">
                  <SelectValue>{(value: string) => labelOf(value)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={WORKTABLE}>
                    {labelOf(WORKTABLE)}
                  </SelectItem>
                  <SelectItem value={SPACE}>{labelOf(SPACE)}</SelectItem>
                  {agents.map((agent) => (
                    <SelectItem
                      key={agent.participantId}
                      value={AGENT + agent.participantId}
                    >
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label
                htmlFor="library-name"
                className="block text-sm font-medium"
              >
                Name
              </label>
              <Input
                id="library-name"
                value={name}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setName(event.target.value)
                  setError(null)
                }}
                onKeyDown={submitOnEnter}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="library-description"
                className="block text-sm font-medium"
              >
                Description
              </label>
              <Input
                id="library-description"
                value={description}
                maxLength={280}
                placeholder="When to use this"
                autoFocus={!isMobile}
                onChange={(event) => {
                  setDescription(event.target.value)
                  setError(null)
                }}
                onKeyDown={submitOnEnter}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "library-error" : undefined}
              />
            </div>
            {error && (
              <p
                id="library-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {error}
              </p>
            )}
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!ready || pending}>
            {pending ? "Adding…" : "Add"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
