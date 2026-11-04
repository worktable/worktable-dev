import { useEffect, useRef, useState } from "react"
import { ImageUp } from "lucide-react"
import type { RecognitionColor } from "@worktable/types/recognition"
import { Button } from "@worktable/ui/components/button"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import { toast } from "@worktable/ui/components/sonner"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@worktable/ui/components/tabs"
import { cn } from "@worktable/ui/lib/utils"
import { IconSearchGrid } from "@/components/icon-search-grid"
import { NamedIcon } from "@/lib/icons"
import { encodeSquare } from "@/lib/identity-image-upload"
import { recognitionSolid } from "@/lib/recognition"

/** The crop area's side, in CSS pixels. */
const VIEW = 240
const MAX_ZOOM = 4
const PREVIEW_SIZES = [48, 32, 24, 16] as const
/** Larger files are refused before they are drawn. */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024

interface Source {
  url: string
  width: number
  height: number
  image: HTMLImageElement
  /** An object URL this dialog made, revoked when replaced. */
  owned: boolean
}

interface Crop {
  zoom: number
  x: number
  y: number
}

function loadSource(url: string, owned: boolean): Promise<Source> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = "async"
    image.onload = () =>
      resolve({
        url,
        // An SVG without its own size draws at a size of our choosing.
        width: image.naturalWidth || 512,
        height: image.naturalHeight || 512,
        image,
        owned,
      })
    image.onerror = () => reject(new Error("Couldn’t read that image."))
    image.src = url
  })
}

function coverScale(source: Source): number {
  return VIEW / Math.min(source.width, source.height)
}

function centered(source: Source): Crop {
  const scale = coverScale(source)
  return {
    zoom: 1,
    x: (VIEW - source.width * scale) / 2,
    y: (VIEW - source.height * scale) / 2,
  }
}

function clamp(source: Source, crop: Crop): Crop {
  const scale = coverScale(source) * crop.zoom
  return {
    zoom: crop.zoom,
    x: Math.min(0, Math.max(VIEW - source.width * scale, crop.x)),
    y: Math.min(0, Math.max(VIEW - source.height * scale, crop.y)),
  }
}

/**
 * Choose a Worktable's logo or a person's photo: an image, cropped to a
 * square, or for a logo an icon from the library on the Worktable's color.
 */
export function IdentityImageDialog({
  open,
  onClose,
  kind,
  currentImage,
  currentIcon,
  color,
  name,
  onSaveImage,
  onSaveIcon,
  onRemove,
}: {
  open: boolean
  onClose: () => void
  kind: "logo" | "photo"
  /** The saved image's address, offered for cropping again. */
  currentImage: string | null
  currentIcon?: string | null
  color: RecognitionColor
  /** Whose initial shows with nothing chosen. */
  name: string
  onSaveImage: (image: Blob) => Promise<void>
  onSaveIcon?: (icon: string) => Promise<void>
  /** Absent when there is nothing to remove. */
  onRemove?: () => Promise<void>
}) {
  const round = kind === "photo"
  const [tab, setTab] = useState<"image" | "icon">(
    currentIcon && onSaveIcon ? "icon" : "image"
  )
  const [source, setSource] = useState<Source | null>(null)
  const [crop, setCrop] = useState<Crop | null>(null)
  const [changed, setChanged] = useState(false)
  const [icon, setIcon] = useState<string | null>(currentIcon ?? null)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const drag = useRef<{
    pointer: number
    x: number
    y: number
    crop: Crop
  } | null>(null)

  // Offer the saved image for cropping again.
  useEffect(() => {
    if (!open || !currentImage) return
    let active = true
    loadSource(currentImage, false).then(
      (loaded) => {
        if (!active) return
        setSource((previous) => previous ?? loaded)
        setCrop((previous) => previous ?? centered(loaded))
      },
      () => {}
    )
    return () => {
      active = false
    }
  }, [open, currentImage])

  // Release an image this dialog read from a file.
  useEffect(
    () => () => {
      if (source?.owned) URL.revokeObjectURL(source.url)
    },
    [source]
  )

  async function choose(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith("image/") || file.size > MAX_SOURCE_BYTES) {
      toast.error("Choose a PNG, JPEG, WebP or SVG image.")
      return
    }
    const url = URL.createObjectURL(file)
    try {
      const loaded = await loadSource(url, true)
      setSource(loaded)
      setCrop(centered(loaded))
      setChanged(true)
      setTab("image")
    } catch (error) {
      URL.revokeObjectURL(url)
      toast.error(
        error instanceof Error ? error.message : "Couldn’t read that image."
      )
    }
  }

  const scale = source && crop ? coverScale(source) * crop.zoom : 1

  function zoomTo(zoom: number) {
    if (!source || !crop) return
    // Zoom around the middle of the crop.
    const middle = VIEW / 2
    const pointX = (middle - crop.x) / scale
    const pointY = (middle - crop.y) / scale
    const next = coverScale(source) * zoom
    setCrop(
      clamp(source, {
        zoom,
        x: middle - pointX * next,
        y: middle - pointY * next,
      })
    )
    setChanged(true)
  }

  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
      onClose()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn’t save. Try again."
      )
    } finally {
      setBusy(false)
    }
  }

  function save() {
    if (tab === "icon" && icon && onSaveIcon) {
      void run(() => onSaveIcon(icon))
      return
    }
    if (!source || !crop) return
    void run(async () =>
      onSaveImage(
        await encodeSquare(source.image, {
          x: -crop.x / scale,
          y: -crop.y / scale,
          size: VIEW / scale,
        })
      )
    )
  }

  const canSave =
    !busy &&
    (tab === "icon"
      ? Boolean(icon) && icon !== currentIcon
      : Boolean(source && crop) && (changed || !currentImage))

  const fallback = (size: number) => (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold",
        round ? "rounded-full" : "rounded-[25%]"
      )}
      style={{
        ...recognitionSolid(color),
        width: size,
        height: size,
        fontSize: size * 0.45,
      }}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  )

  const previews = (
    <div className="flex items-end justify-center gap-4 rounded-lg bg-surface-inset p-3">
      {PREVIEW_SIZES.map((size) => {
        const shape = cn(
          "shrink-0 overflow-hidden",
          round ? "rounded-full" : "rounded-[25%]"
        )
        if (tab === "icon") {
          return icon ? (
            <span
              key={size}
              aria-hidden
              className={cn(shape, "flex items-center justify-center")}
              style={{ ...recognitionSolid(color), width: size, height: size }}
            >
              <NamedIcon
                name={icon}
                style={{ width: size * 0.6, height: size * 0.6 }}
              />
            </span>
          ) : (
            <span key={size}>{fallback(size)}</span>
          )
        }
        if (!source || !crop) return <span key={size}>{fallback(size)}</span>
        const ratio = size / VIEW
        return (
          <span
            key={size}
            aria-hidden
            className={cn(shape, "ring-1 ring-border ring-inset")}
            style={{
              width: size,
              height: size,
              backgroundImage: `url("${source.url}")`,
              backgroundRepeat: "no-repeat",
              backgroundSize: `${source.width * scale * ratio}px ${source.height * scale * ratio}px`,
              backgroundPosition: `${crop.x * ratio}px ${crop.y * ratio}px`,
            }}
          />
        )
      })}
    </div>
  )

  const imagePane = (
    <div className="flex flex-col items-center gap-3">
      <div
        className={cn(
          "relative touch-none overflow-hidden rounded-xl select-none",
          source ? "cursor-grab active:cursor-grabbing" : "",
          dragOver && "ring-2 ring-primary"
        )}
        style={{ width: VIEW, height: VIEW }}
        onDragOver={(event) => {
          event.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragOver(false)
          void choose(event.dataTransfer.files[0])
        }}
        onPointerDown={(event) => {
          if (!crop) return
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = {
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            crop,
          }
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (!start || start.pointer !== event.pointerId || !source) return
          setCrop(
            clamp(source, {
              zoom: start.crop.zoom,
              x: start.crop.x + event.clientX - start.x,
              y: start.crop.y + event.clientY - start.y,
            })
          )
          setChanged(true)
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        {source && crop ? (
          <>
            <img
              src={source.url}
              alt=""
              draggable={false}
              className="pointer-events-none absolute top-0 left-0 max-w-none origin-top-left"
              style={{
                width: source.width,
                height: source.height,
                transform: `translate(${crop.x}px, ${crop.y}px) scale(${scale})`,
              }}
            />
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-0",
                round
                  ? "rounded-full shadow-[0_0_0_400px_rgb(0_0_0/0.4)]"
                  : "rounded-xl ring-1 ring-border ring-inset"
              )}
            />
          </>
        ) : (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground transition-colors duration-150 hover:bg-surface-hover"
          >
            <ImageUp className="size-5" aria-hidden />
            Choose Image
          </button>
        )}
      </div>
      {source && crop ? (
        <div className="flex w-60 items-center gap-3">
          <input
            type="range"
            aria-label="Zoom"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={crop.zoom}
            onChange={(event) => zoomTo(Number(event.target.value))}
            className="flex-1 accent-primary"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileInput.current?.click()}
          >
            Replace
          </Button>
        </div>
      ) : null}
    </div>
  )

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => !next && !busy && onClose()}
    >
      <ResponsiveDialogContent
        onPaste={(event) => {
          const file = Array.from(event.clipboardData.files).find((item) =>
            item.type.startsWith("image/")
          )
          if (file) void choose(file)
        }}
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {kind === "logo" ? "Logo" : "Photo"}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            hidden
            onChange={(event) => {
              void choose(event.target.files?.[0])
              event.target.value = ""
            }}
          />
          {onSaveIcon ? (
            <Tabs
              value={tab}
              onValueChange={(value) => setTab(value as "image" | "icon")}
            >
              <TabsList aria-label="Logo kind" className="self-center">
                <TabsTrigger value="image">Image</TabsTrigger>
                <TabsTrigger value="icon">Icon</TabsTrigger>
              </TabsList>
              <TabsContent value="image" className="pt-2">
                {imagePane}
              </TabsContent>
              <TabsContent value="icon" className="pt-2">
                <IconSearchGrid
                  selected={icon}
                  onSelect={setIcon}
                  className="max-h-48"
                />
              </TabsContent>
            </Tabs>
          ) : (
            imagePane
          )}
          <div className="mt-4">{previews}</div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          {onRemove ? (
            <Button
              variant="ghost"
              className="sm:mr-auto"
              disabled={busy}
              onClick={() => void run(onRemove)}
            >
              Remove
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
