import {
  Children,
  cloneElement,
  createElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
} from "react"

/**
 * A Markdown ordered list whose items carry their number. The marker is then
 * drawn from one string, "1.", as the editor draws it; a CSS counter would be
 * a separate text run that the font cannot kern against the period.
 */
export function NumberedList({
  start,
  children,
  ...props
}: ComponentProps<"ol">): ReactElement {
  let index = typeof start === "number" && Number.isFinite(start) ? start : 1
  const items = Children.map(children, (child) =>
    isValidElement(child) && child.type === "li"
      ? cloneElement(child as ReactElement<Record<string, unknown>>, {
          "data-index": index++,
        })
      : child
  )
  return createElement("ol", { ...props, start }, items)
}
