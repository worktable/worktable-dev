import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"

/** Marks a <summary> so DocDetails can lift it into the trigger. */
export function DocSummary({ children }: { children?: ReactNode }) {
  return <>{children}</>
}

/** An HTML <details> toggle that opens and closes with a height transition. */
export function DocDetails({
  open,
  children,
}: {
  open?: boolean
  children?: ReactNode
}) {
  const items = Children.toArray(children)
  const summary = items.find(
    (item): item is ReactElement<{ children?: ReactNode }> =>
      isValidElement(item) && item.type === DocSummary
  )
  const body = items.filter((item) => item !== summary)
  return (
    <Collapsible
      defaultOpen={Boolean(open)}
      render={<div className="worktable-details" />}
    >
      <CollapsibleTrigger
        render={<div className="worktable-summary" />}
        nativeButton={false}
      >
        {summary?.props.children ?? "Details"}
      </CollapsibleTrigger>
      <CollapsibleContent className="worktable-details-body">
        {body}
      </CollapsibleContent>
    </Collapsible>
  )
}
