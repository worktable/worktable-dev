import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactElement,
} from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  AppWindow,
  Clock3,
  Database,
  FileText,
  Monitor,
  Pencil,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { Input } from "@worktable/ui/components/input"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import { toast } from "@worktable/ui/components/sonner"
import { useIsMobile } from "@/hooks/use-mobile"
import { useNewDoc } from "@/hooks/use-new-doc"
import { useNewDocumentLifetime } from "@/lib/lifetime"
import {
  queryKeys,
  recordCollectionsQueryOptions,
  useWorkspace,
} from "@/lib/queries"
import { createRecordCollection } from "@/lib/records-api"
import { createWidget } from "@/lib/widgets-api"

const NewCollectionDialog = lazy(() =>
  import("@/components/records/new-collection-dialog").then((module) => ({
    default: module.NewCollectionDialog,
  }))
)
const NewDrawingDialog = lazy(() =>
  import("@/components/new-drawing-dialog").then((module) => ({
    default: module.NewDrawingDialog,
  }))
)

/**
 * Everything a Space can create, behind one menu. The sidebar and Space Home
 * pass their own trigger; creation and its dialogs behave the same in both.
 */
export function SpaceNewMenu({
  spaceId,
  trigger,
  align = "end",
  onCreated,
}: {
  spaceId: string
  trigger: ReactElement
  align?: "start" | "end"
  onCreated?: () => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: workspace } = useWorkspace()
  const [lifetime, setLifetime] = useNewDocumentLifetime()
  const [drawingOpen, setDrawingOpen] = useState(false)
  const [widgetOpen, setWidgetOpen] = useState(false)
  const [collectionOpen, setCollectionOpen] = useState(false)
  const newDoc = useNewDoc(spaceId, onCreated)

  // Rethrows on failure: the dialog stays open so the entered name and
  // description survive a rejected create.
  const createCollection = async (name: string, description?: string) => {
    // The server route upserts by slug, so a colliding name would silently
    // edit the existing collection's schema — refuse it here instead.
    const slug =
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "collection"
    try {
      // staleTime 0 forces a network read: a 30s-stale cached list could miss
      // a collection another client just created and fall into the upsert.
      const existing = await queryClient.fetchQuery({
        ...recordCollectionsQueryOptions(spaceId),
        staleTime: 0,
      })
      if (existing.some((collection) => collection.id === slug)) {
        toast.error(`A collection with id "${slug}" already exists`)
        throw new Error("duplicate collection id")
      }
      const collection = await createRecordCollection(spaceId, {
        name,
        ...(description ? { description } : {}),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.recordCollections(spaceId),
      })
      onCreated?.()
      void navigate({
        to: "/spaces/$spaceId/records/$",
        params: { spaceId, _splat: collection.id },
      })
      toast.success("Collection created")
    } catch (err) {
      if (
        !(err instanceof Error && err.message === "duplicate collection id")
      ) {
        // The strict-create 409 carries a specific message; surface it.
        const message =
          err instanceof Error && err.message.includes("already exists")
            ? err.message
            : "Failed to create collection"
        toast.error(message)
        console.error("Failed to create record collection:", err)
      }
      throw err
    }
  }

  const createWidgetShell = async (name: string, description?: string) => {
    try {
      const result = await createWidget(spaceId, {
        name,
        description,
        html: buildWidgetShellHtml(name),
        metadata: { source: "manual-shell" },
        lifetime,
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
      void queryClient.invalidateQueries({ queryKey: queryKeys.space(spaceId) })
      onCreated?.()
      void navigate({
        to: "/spaces/$spaceId/documents/$",
        params: { spaceId, _splat: result.widgetId },
      })
      toast.success("HTML doc shell created")
    } catch (err) {
      toast.error("Failed to create HTML doc shell")
      console.error("Failed to create HTML doc shell:", err)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent align={align} sideOffset={4} className="min-w-60">
          <DropdownMenuItem onClick={() => newDoc()}>
            <FileText className="mr-2 h-4 w-4" />
            Doc
          </DropdownMenuItem>
          {workspace?.storageVersion === 2 && (
            <DropdownMenuItem onClick={() => setDrawingOpen(true)}>
              <Pencil className="mr-2 h-4 w-4" />
              Drawing
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setWidgetOpen(true)}>
            <AppWindow className="mr-2 h-4 w-4" />
            HTML Doc
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setCollectionOpen(true)}>
            <Database className="mr-2 h-4 w-4" />
            Record Collection
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={lifetime === "temporary"}
            closeOnClick={false}
            onCheckedChange={(checked) => {
              setLifetime(checked ? "temporary" : "durable")
            }}
          >
            <Clock3 className="mr-2 h-4 w-4" />
            Start as Temporary
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {drawingOpen && (
        <Suspense fallback={null}>
          <NewDrawingDialog
            spaceId={spaceId}
            lifetime={lifetime}
            onClose={() => setDrawingOpen(false)}
            onCreated={() => onCreated?.()}
          />
        </Suspense>
      )}
      <NewWidgetDialog
        open={widgetOpen}
        onClose={() => setWidgetOpen(false)}
        onCreate={createWidgetShell}
      />
      <DeferredMount active={collectionOpen}>
        <NewCollectionDialog
          open={collectionOpen}
          onClose={() => setCollectionOpen(false)}
          onCreate={createCollection}
        />
      </DeferredMount>
    </>
  )
}

const INVALID_WIDGET_CHARS = /[<>:"|?*\\]/
const MAX_WIDGET_NAME_LENGTH = 80
const MAX_WIDGET_DESCRIPTION_LENGTH = 180

function sanitizeWidgetName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\.{2,}/g, ".")
}

function validateWidgetName(name: string): string | null {
  if (!name) return null
  if (INVALID_WIDGET_CHARS.test(name)) return "Name contains invalid characters"
  if (name.length > MAX_WIDGET_NAME_LENGTH)
    return `Name must be under ${MAX_WIDGET_NAME_LENGTH} characters`
  if (name === "." || name === "..") return "Invalid name"
  return null
}

function NewWidgetDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  onCreate: (name: string, description?: string) => Promise<void>
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [pending, setPending] = useState(false)
  const isMobile = useIsMobile()

  useEffect(() => {
    if (open) {
      setName("")
      setDescription("")
      setPending(false)
    }
  }, [open])

  const sanitizedName = sanitizeWidgetName(name)
  const trimmedDescription = description.trim()
  const validationError = validateWidgetName(sanitizedName)
  const canCreate = sanitizedName.length > 0 && !validationError && !pending

  const handleCreate = async () => {
    if (!canCreate) return
    setPending(true)
    try {
      await onCreate(sanitizedName, trimmedDescription || undefined)
      onClose()
    } finally {
      setPending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canCreate) {
      void handleCreate()
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <Monitor className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>New HTML doc</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Create an empty HTML doc shell an agent can fill in later.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <div className="space-y-2">
            <label htmlFor="widget-name" className="text-sm font-medium">
              HTML doc name
            </label>
            <Input
              id="widget-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Open Items"
              className="h-9"
              maxLength={MAX_WIDGET_NAME_LENGTH}
              autoFocus={!isMobile}
            />
            {validationError && name.trim() && (
              <p className="text-xs text-destructive">{validationError}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="widget-description" className="text-sm font-medium">
              Description{" "}
              <span className="font-normal text-muted-foreground">
                optional
              </span>
            </label>
            <Input
              id="widget-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What should this HTML doc help with?"
              className="h-9"
              maxLength={MAX_WIDGET_DESCRIPTION_LENGTH}
            />
          </div>
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!canCreate}>
            {pending ? "Creating…" : "Create HTML doc"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function buildWidgetShellHtml(name: string): string {
  const escapedName = escapeHtml(name)
  return `<!doctype html>
<html data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedName}</title>
  <style>
    :root {
      color-scheme: light dark;
      --ad-bg: #f7f4ee;
      --ad-surface: rgba(255, 255, 255, 0.86);
      --ad-text: #20252d;
      --ad-muted: #667085;
      --ad-border: rgba(32, 37, 45, 0.13);
    }
    html[data-theme="dark"] {
      --ad-bg: #0d1117;
      --ad-surface: rgba(255, 255, 255, 0.035);
      --ad-text: #f4f7fb;
      --ad-muted: #9aa7b2;
      --ad-border: rgba(255, 255, 255, 0.12);
    }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      background: var(--ad-bg);
      color: var(--ad-text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      max-width: 520px;
      margin: 24px;
      padding: 20px;
      border: 1px dashed var(--ad-border);
      border-radius: 14px;
      background: var(--ad-surface);
      text-align: center;
    }
    h1 { margin: 0 0 6px; font-size: 16px; font-weight: 500; line-height: 1.3; }
    p { margin: 0; color: var(--ad-muted); font-size: 13px; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>${escapedName}</h1>
    <p>Empty HTML doc. Ask an agent to build it out.</p>
  </main>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}
