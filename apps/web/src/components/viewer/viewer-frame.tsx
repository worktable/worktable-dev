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
  VIEWER_FIRST_BYTES,
  VIEWER_MAX_BYTES,
  VIEWER_WHOLE_FILE_BYTES,
  viewerAssetPath,
  viewerFrameMessage,
  viewerFrameSecret,
  type ViewerCommand,
  type ViewerHostMessage,
  type ViewerKey,
  type ViewerRefusal,
  type ViewerState,
} from "@/lib/viewer-frame-protocol"

/** What a viewer frame's page can ask of it. */
export interface ViewerFrameHandle {
  command: (command: ViewerCommand) => void
  /** Answer a file's request for a password; null gives up on it. */
  password: (password: string | null) => void
}

/** How long a frame has to show the file before the page gives up on it. */
const SHOW_DEADLINE_MS = 30_000

/**
 * How long one of the viewer's own files may take to arrive. It doesn't
 * count toward showing the file, so it has its own limit: room for the Word
 * viewer's engine over slow mobile data.
 */
const ASSET_DEADLINE_MS = 120_000

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
  onFind,
  onPassword,
  onRail,
  onKey,
}: {
  ref?: Ref<ViewerFrameHandle>
  viewer: ViewerKey
  title: string
  /** The file's bytes at the version its page loaded. */
  fileUrl: string
  /** The file's size when the page knows it; else the first read finds it. */
  byteLength?: number | undefined
  startPage?: number
  className?: string
  onShown: (state: ViewerState) => void
  onState: (state: ViewerState) => void
  /** The viewer couldn't show this file; the page shows a card instead. */
  onRefused: (reason: ViewerRefusal) => void
  /** The file changed while it was being read. */
  onChanged: () => void
  /** Where finding text has got to: the match shown, of how many. */
  onFind?: (found: { current: number; total: number }) => void
  /** The file needs a password; `retry` when the last one was wrong. */
  onPassword?: (retry: boolean) => void
  /** The page browser opened or closed itself. */
  onRail?: (open: boolean) => void
  onKey?: (key: string) => void
}) {
  const { resolvedTheme } = useTheme()
  const frame = useRef<HTMLIFrameElement>(null)
  const post = useRef<
    (message: ViewerHostMessage, transfer?: Transferable[]) => void
  >(() => {})
  const [settled, setSettled] = useState(false)
  const handlers = useRef({
    onShown,
    onState,
    onRefused,
    onChanged,
    onFind,
    onPassword,
    onRail,
    onKey,
  })
  useEffect(() => {
    handlers.current = {
      onShown,
      onState,
      onRefused,
      onChanged,
      onFind,
      onPassword,
      onRail,
      onKey,
    }
  })
  const answerPassword = useRef<(password: string | null) => void>(() => {})
  // The frame starts in the theme of the moment and follows it from there,
  // so a change of theme never restarts it and loses the reader's place.
  const [startTheme] = useState(resolvedTheme)
  // Only the frame this page loads learns its secret; see viewerFrameSecret.
  const [secret] = useState(viewerFrameSecret)
  const src = `${viewerUrl(viewer, "", [`theme=${startTheme}`])}#${secret}`
  useEffect(() => {
    post.current({ type: "viewer.theme", theme: resolvedTheme })
  }, [resolvedTheme])

  useImperativeHandle(ref, () => ({
    command: (command) => post.current({ type: "viewer.command", command }),
    password: (password) => answerPassword.current(password),
  }))

  useEffect(() => {
    const element = frame.current
    if (!element) return
    setSettled(false)
    // The channel the frame document handed over with its handshake. Only
    // that document holds the other end, and it closes with it: whatever the
    // frame is navigated to later can't hear a word.
    let port: MessagePort | null = null
    let over = false
    let etag: string | null = null
    // The file's size: from its page, or else from the first response.
    let length = byteLength ?? -1
    const abort = new AbortController()

    const send = (
      message: ViewerHostMessage,
      transfer: Transferable[] = []
    ) => {
      if (!over) port?.postMessage(message, transfer)
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
        ...(begin === 0 && end === length
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
      if (length < 0) {
        // The whole file, or a range that names the whole file's size.
        const total = /\/(\d+)$/.exec(
          response.headers.get("content-range") ?? ""
        )
        length = total
          ? Number(total[1])
          : Number(response.headers.get("content-length") ?? -1)
      }
      return response.arrayBuffer()
    }
    // Past the largest file a viewer opens, nothing is read.
    let tooLarge = length > VIEWER_MAX_BYTES
    /** The file's first bytes, or all of them when it is small. */
    const first = async (): Promise<{
      data: ArrayBuffer
      whole: boolean
    } | null> => {
      if (tooLarge) return null
      if (length < 0) {
        const head = await read(0, VIEWER_FIRST_BYTES)
        if (!head || length < 0) return null
        if (length > VIEWER_MAX_BYTES) {
          tooLarge = true
          return null
        }
        if (head.byteLength >= length) return { data: head, whole: true }
        if (length > VIEWER_WHOLE_FILE_BYTES)
          return { data: head, whole: false }
      }
      const whole = length <= VIEWER_WHOLE_FILE_BYTES
      const data = await read(
        0,
        whole ? length : Math.min(VIEWER_FIRST_BYTES, length)
      )
      return data ? { data, whole } : null
    }
    // The file starts loading with the frame, not after it.
    const start = first().catch(() => null)
    // The time to show the file, paused while the reader types a password
    // and while the viewer's own files download: a Word viewer's engine is
    // several MB on its first open, which slow mobile data takes a while to
    // bring.
    let shown = false
    let asking = false
    let fetching = 0
    let deadline = 0
    const startDeadline = () => {
      window.clearTimeout(deadline)
      if (!shown && !asking && fetching === 0 && !over)
        deadline = window.setTimeout(() => refuse("failed"), SHOW_DEADLINE_MS)
    }
    startDeadline()
    answerPassword.current = (password) => {
      asking = false
      if (password !== null) startDeadline()
      send({ type: "viewer.password", password })
    }

    // The handshake comes on the window, from the frame's document with no
    // origin, naming the secret only the document this page loaded knows, and
    // carrying the channel everything else goes over. Anything else in the
    // frame's place ends the open.
    const onHandshake = (event: MessageEvent) => {
      if (event.source !== element.contentWindow || event.origin !== "null")
        return
      const message = viewerFrameMessage(event.data)
      if (message?.type !== "viewer.handshake" || port !== null || over) return
      const channel = event.ports[0]
      if (message.token !== secret || !channel) {
        refuse("failed")
        return
      }
      port = channel
      port.onmessage = (portEvent) => void onMessage(portEvent)
      void open()
    }
    const open = async () => {
      const opened = await start
      if (!opened) return refuse(tooLarge ? "too-large" : "failed")
      send(
        {
          type: "viewer.open",
          byteLength: length,
          start: opened.data,
          whole: opened.whole,
          ...(startPage ? { page: startPage } : {}),
        },
        [opened.data]
      )
    }
    const onMessage = async (event: MessageEvent) => {
      const message = viewerFrameMessage(event.data)
      if (!message || over || message.token !== secret) return
      switch (message.type) {
        case "viewer.read": {
          const range = clampViewerRead(message.begin, message.end, length)
          // The whole of what it asked for, or nothing: pdf.js can't use
          // part of a piece.
          // A read that fails is tried twice more, a moment apart; one that
          // still fails ends the open, and the page shows why.
          let data: ArrayBuffer | null = null
          for (let attempt = 0; range && attempt < 3 && !over; attempt++) {
            if (attempt > 0)
              await new Promise((r) => setTimeout(r, 500 * attempt))
            data = await read(range.begin, range.end).catch(() => null)
            if (data) break
          }
          if (!data) return refuse("failed")
          send({ type: "viewer.bytes", begin: message.begin, data }, [data])
          return
        }
        case "viewer.asset": {
          const path = viewerAssetPath(message)
          fetching += 1
          window.clearTimeout(deadline)
          // A transfer that stalls ends as one that failed, as does one
          // the frame closes on.
          const transfer = new AbortController()
          const stop = () => transfer.abort()
          abort.signal.addEventListener("abort", stop, { once: true })
          const timer = window.setTimeout(stop, ASSET_DEADLINE_MS)
          const response = path
            ? await authenticatedFetch(
                viewerUrl(viewer, `/files/${path}`, []),
                { signal: transfer.signal }
              ).catch(() => null)
            : null
          const data = response?.ok
            ? await response.arrayBuffer().catch(() => null)
            : null
          window.clearTimeout(timer)
          abort.signal.removeEventListener("abort", stop)
          fetching -= 1
          startDeadline()
          send(
            { type: "viewer.asset", id: message.id, data },
            data ? [data] : []
          )
          return
        }
        case "viewer.shown":
          shown = true
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
        case "viewer.find":
          handlers.current.onFind?.({
            current: message.current,
            total: message.total,
          })
          return
        case "viewer.password":
          asking = true
          window.clearTimeout(deadline)
          handlers.current.onPassword?.(message.retry === true)
          return
        case "viewer.rail":
          handlers.current.onRail?.(message.open === true)
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
    window.addEventListener("message", onHandshake)
    element.addEventListener("load", onLoad)
    return () => {
      over = true
      post.current = () => {}
      answerPassword.current = () => {}
      abort.abort()
      window.clearTimeout(deadline)
      window.removeEventListener("message", onHandshake)
      port?.close()
      element.removeEventListener("load", onLoad)
    }
  }, [byteLength, fileUrl, secret, src, startPage, viewer])

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
