import { useEffect, useRef } from "react"
import type { RecognitionColor } from "@worktable/types/recognition"
import type { TileLogo } from "@/lib/recognition"
import { NamedIcon } from "@/lib/icons"

const SIDE = 64
const RADIUS = 14

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = src
  })
}

/** A recognition color as the canvas can paint it. */
function resolvedColor(color: RecognitionColor): string {
  const probe = document.createElement("span")
  probe.style.backgroundColor = `var(--recognition-${color})`
  probe.style.display = "none"
  document.body.append(probe)
  const value = getComputedStyle(probe).backgroundColor
  probe.remove()
  return value
}

/**
 * The icon's SVG once it has rendered. A less common icon loads first, with
 * a folder holding its place, so wait for the icon itself.
 */
async function renderedIcon(
  holder: HTMLElement,
  icon: string
): Promise<SVGSVGElement | null> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const svg = holder.querySelector("svg")
    if (
      svg &&
      (icon === "folder" || !svg.classList.contains("lucide-folder"))
    ) {
      return svg
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

async function drawFavicon(
  logo: TileLogo,
  color: RecognitionColor,
  holder: HTMLElement | null
): Promise<string | null> {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = SIDE
  const context = canvas.getContext("2d")
  if (!context) return null
  context.beginPath()
  context.roundRect(0, 0, SIDE, SIDE, RADIUS)
  context.clip()
  if (logo.kind === "image") {
    const image = await loadImage(logo.src)
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      SIDE,
      SIDE
    )
  } else {
    const svg = holder ? await renderedIcon(holder, logo.icon) : null
    if (!svg) return null
    context.fillStyle = resolvedColor(color)
    context.fillRect(0, 0, SIDE, SIDE)
    const copy = svg.cloneNode(true) as SVGSVGElement
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg")
    copy.setAttribute("stroke", "#fff")
    copy.setAttribute("width", "36")
    copy.setAttribute("height", "36")
    copy.removeAttribute("class")
    const icon = await loadImage(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(copy.outerHTML)}`
    )
    context.drawImage(icon, 14, 14, 36, 36)
  }
  return canvas.toDataURL("image/png")
}

/**
 * The browser tab shows the Worktable's logo, so tabs from different
 * Worktables can be told apart. Without a logo it keeps Worktable's own icon.
 */
export function WorktableFavicon({
  color,
  logo,
}: {
  color: RecognitionColor
  logo: TileLogo | null
}) {
  const holder = useRef<HTMLSpanElement>(null)
  const key = logo
    ? logo.kind === "icon"
      ? `icon:${logo.icon}`
      : `image:${logo.src}`
    : null
  useEffect(() => {
    if (!logo) return
    let active = true
    const links = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')
    )
    const originals = links.map((link) => ({
      link,
      href: link.getAttribute("href"),
      type: link.getAttribute("type"),
    }))
    void drawFavicon(logo, color, holder.current).then(
      (url) => {
        if (!active || !url) return
        for (const link of links) {
          link.href = url
          link.type = "image/png"
        }
      },
      () => {}
    )
    return () => {
      active = false
      for (const { link, href, type } of originals) {
        if (href === null) link.removeAttribute("href")
        else link.setAttribute("href", href)
        if (type === null) link.removeAttribute("type")
        else link.setAttribute("type", type)
      }
    }
    // The key names the logo; a new object with the same logo changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, color])
  return logo?.kind === "icon" ? (
    <span ref={holder} hidden>
      <NamedIcon name={logo.icon} />
    </span>
  ) : null
}
