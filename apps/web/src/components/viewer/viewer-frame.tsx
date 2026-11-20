import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react"
import { useTheme } from "@/components/theme-provider"
import { buildVersionQuery } from "@/lib/build-version"
import { authenticatedFetch, BASE_URL } from "@/lib/http"
import {
  clampViewerRead,
  VIEWER_PIECE_BYTES,
  VIEWER_WHOLE_FILE_BYTES,
  viewerAssetPath,
  viewerFrameMessage,
  type ViewerCommand,
  type ViewerHostMessage,
  type ViewerKey,
  type ViewerRefusal,
  type ViewerState,
} from "@/lib/viewer-frame-protocol"

/** What a viewer frame's page can ask of it. */
export interface ViewerFrameHandle {
  command: (command: ViewerCommand) => void
}

/** How long a frame has to show the file before the page gives up on it. */
const SHOW_DEADLINE_MS = 30_000
/** The most a frame is handed for one read, whatever it asked for. */
const READ_MAX_BYTES = 16 * VIEWER_PIECE_BYTES

function viewerUrl(viewer: ViewerKey, rest: string, query: string[]): string {
  const version = buildVersionQuery()
  const all = [...query, ...(version ? [version] : [])].join("&")
  return `${BASE_URL}/api/viewers/${viewer}${rest}${all ? `?${all}` : ""}`
}

/**
 * A file shown by a viewer frame: a document with no origin and no network
 * that parses the file. This page holds the session, so it fetches the
 * file, from one version of it, and hands the frame the bytes it asks for;
 * the frame can name nothing else. A frame that reloads or goes elsewhere
 * is no longer answered.
 */
export function ViewerFrame({
  ref,
  viewer,
  title,
  fileUrl,
  byteLength,
  startPage,
  className,
  onShown,
  onState,
  onRefused,
  onChanged,
  onKey,
}: {
  ref?: Ref<ViewerFrameHandle>
  viewer: ViewerKey
  title: string
  /** The file's bytes at the version its page loaded. */
  fileUrl: string
  byteLength: number
  startPage?: number
  className?: string
  onShown: (state: ViewerState) => void
  onState: (state: ViewerState) => void
  /** The viewer couldn't show this file; the page shows a card instead. */
  onRefused: (reason: ViewerRefusal) => void
  /** The file changed while it was being read. */
  onChanged: () => void
  onKey?: (key: string) => void
}) {
  const { resolvedTheme } = useTheme()
  const frame = useRef<HTMLIFrameElement>(null)
  const post = useRef<
    (message: ViewerHostMessage, transfer?: Transferable[]) => void
  >(() => {})
  const [settled, setSettled] = useState(false)
  const handlers = useRef({ onShown, onState, onRefused, onChanged, onKey })
  useEffect(() => {
    handlers.current = { onShown, onState, onRefused, onChanged, onKey }
  })
  const src = viewerUrl(viewer, "", [`theme=${resolvedTheme}`])

  useImperativeHandle(ref, () => ({
    command: (command) => post.current({ type: "viewer.command", command }),
  }))

  useEffect(() => {
    const element = frame.current
    if (!element) return
    setSettled(false)
    let token: string | null = null
    let over = false
    let etag: string | null = null
    const whole = byteLength <= VIEWER_WHOLE_FILE_BYTES
    const abort = new AbortController()

    const send = (
      message: ViewerHostMessage,
      transfer: Transferable[] = []
    ) => {
      if (!over) element.contentWindow?.postMessage(message, "*", transfer)
    }
    post.current = send
    const refuse = (reason: ViewerRefusal) => {
      if (over) return
      over = true
      handlers.current.onRefused(reason)
    }

    /** Bytes of the file, all from the version the first response named. */
    const read = async (
      begin: number,
      end: number
    ): Promise<ArrayBuffer | null> => {
      const response = await authenticatedFetch(fileUrl, {
        signal: abort.signal,
        ...(begin === 0 && end === byteLength
          ? {}
          : { headers: { Range: `bytes=${begin}-${end - 1}` } }),
      })
      if (!response.ok) return null
      const named = response.headers.get("etag")
      etag ??= named
      if (named !== etag) {
        over = true
        handlers.current.onChanged()
        return null
      }
      return response.arrayBuffer()
    }
    // The file starts loading with the frame, not after it.
    const start = read(
      0,
      whole ? byteLength : Math.min(VIEWER_PIECE_BYTES, byteLength)
    ).catch(() => null)
    const deadline = window.setTimeout(() => refuse("failed"), SHOW_DEADLINE_MS)

    const onMessage = async (event: MessageEvent) => {
      // Only this frame, and only while it is the document with no origin
      // that was served to it.
      if (event.source !== element.contentWindow || event.origin !== "null")
        return
      const message = viewerFrameMessage(event.data)
      if (!message || over) return
      if (message.type === "viewer.handshake") {
        if (token !== null) return
        token = message.token
        const data = await start
        if (!data) return refuse("failed")
        send(
          {
            type: "viewer.open",
            byteLength,
            start: data,
            whole,
            ...(startPage ? { page: startPage } : {}),
          },
          [data]
        )
        return
      }
      if (message.token !== token) return
      switch (message.type) {
        case "viewer.read": {
          const range = clampViewerRead(message.begin, message.end, byteLength)
          const data = range
            ? await read(
                range.begin,
                Math.min(range.end, range.begin + READ_MAX_BYTES)
              ).catch(() => null)
            : null
          send(
            { type: "viewer.bytes", begin: message.begin, data },
            data ? [data] : []
          )
          return
        }
        case "viewer.asset": {
          const path = viewerAssetPath(message)
          const response = path
            ? await authenticatedFetch(
                viewerUrl(viewer, `/files/${path}`, []),
                {
                  signal: abort.signal,
                }
              ).catch(() => null)
            : null
          const data = response?.ok ? await response.arrayBuffer() : null
          send(
            { type: "viewer.asset", id: message.id, data },
            data ? [data] : []
          )
          return
        }
        case "viewer.shown":
          window.clearTimeout(deadline)
          setSettled(true)
          handlers.current.onShown(message)
          return
        case "viewer.state":
          handlers.current.onState(message)
          return
        case "viewer.refused":
          window.clearTimeout(deadline)
          refuse(message.reason)
          return
        case "viewer.link":
          openLink(message.url)
          return
        case "viewer.key":
          handlers.current.onKey?.(message.key)
          return
        default:
          return
      }
    }
    // A second load means the frame went somewhere else: stop answering.
    let loads = 0
    const onLoad = () => {
      loads += 1
      if (loads > 1) refuse("failed")
    }
    window.addEventListener("message", onMessage)
    element.addEventListener("load", onLoad)
    return () => {
      over = true
      post.current = () => {}
      abort.abort()
      window.clearTimeout(deadline)
      window.removeEventListener("message", onMessage)
      element.removeEventListener("load", onLoad)
    }
  }, [byteLength, fileUrl, src, startPage, viewer])

  return (
    <iframe
      ref={frame}
      // A new address is a new frame, and a new handshake with it.
      key={src}
      title={title}
      src={src}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      data-viewer-frame={viewer}
      data-settled={settled ? "" : undefined}
      className={className}
    />
  )
}

/** A link from inside a file opens in a new tab, and only to the web or mail. */
function openLink(url: string): void {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return
  }
  if (!["http:", "https:", "mailto:"].includes(target.protocol)) return
  // The page it opens gets no handle on this one, and no referrer.
  const link = document.createElement("a")
  link.href = target.href
  link.target = "_blank"
  link.rel = "noopener noreferrer"
  link.click()
}
