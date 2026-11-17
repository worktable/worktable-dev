import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useLocation } from "@tanstack/react-router"
import { X } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@worktable/ui/components/tabs"
import type { AnnotationPanelProps } from "./annotation-panel"
import { AnnotationPanelContent } from "./annotation-panel-content"
import { VisitorCommentsPanel } from "./visitor-comments-panel"

export function DocumentCommentsPanel(props: AnnotationPanelProps) {
  const hash = useLocation({ select: (location) => location.hash })
  const context = props.visitorComments!
  const key = `${context.documentId}:${hash}`
  const [selection, setSelection] = useState({
    key,
    tab: hash === "visitors" ? "visitors" : "comments",
  })
  const tab =
    selection.key === key
      ? selection.tab
      : hash === "visitors"
        ? "visitors"
        : "comments"
  if (selection.key !== key) setSelection({ key, tab })
  const setTab = (tab: string) => setSelection({ key, tab })
  const commentsTabs = useRef<HTMLDivElement>(null)
  const visitorsTabs = useRef<HTMLDivElement>(null)
  const restoreTabFocus = useRef(false)
  useLayoutEffect(() => {
    if (!restoreTabFocus.current) return
    restoreTabFocus.current = false
    // Each panel owns its heading; restore the focused trigger after the swap.
    const list = (tab === "visitors" ? visitorsTabs : commentsTabs).current
    list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [tab])
  const openCount = props.annotations.filter(
    (annotation) => annotation.status !== "resolved"
  ).length
  const header = (actions: ReactNode, panel: "comments" | "visitors") => (
    <div className="flex shrink-0 items-center justify-between gap-2 p-4 pb-2">
      <TabsList ref={panel === "comments" ? commentsTabs : visitorsTabs} aria-label="Document comments">
        <TabsTrigger value="comments">
          Comments{" "}
          <span className="text-xs text-muted-foreground">{openCount}</span>
        </TabsTrigger>
        <TabsTrigger value="visitors">
          Visitors{" "}
          <span className="text-xs text-muted-foreground">
            {context.newCount}
          </span>
        </TabsTrigger>
      </TabsList>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  )
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (value === tab) return
        restoreTabFocus.current =
          Boolean(commentsTabs.current?.contains(document.activeElement) ||
            visitorsTabs.current?.contains(document.activeElement))
        setTab(String(value))
      }}
      className="h-full min-h-0 gap-0"
    >
      <TabsContent value="comments" className="min-h-0">
        <AnnotationPanelContent {...props} header={(actions) => header(actions, "comments")} />
      </TabsContent>
      <TabsContent value="visitors" className="flex min-h-0 flex-col">
        {header(
          props.onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close comments"
              onClick={props.onClose}
            >
              <X className="size-4" />
            </Button>
          ),
          "visitors"
        )}
        {tab === "visitors" && (
          <VisitorCommentsPanel
            context={context}
            onViewComment={(annotation) => {
              setTab("comments")
              props.onSelectAnnotation(annotation)
            }}
            annotations={props.annotations}
          />
        )}
      </TabsContent>
    </Tabs>
  )
}
