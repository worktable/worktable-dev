import { useState } from "react"
import { X } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@worktable/ui/components/tabs"
import type { AnnotationPanelProps } from "./annotation-panel"
import { AnnotationCommentsPanel } from "./annotation-comments"
import { VisitorCommentsPanel } from "./visitor-comments-panel"

export function DocumentCommentsPanel(props: AnnotationPanelProps) {
  const [tab, setTab] = useState<string>("comments")
  const context = props.visitorComments!
  const openCount = props.annotations.filter(annotation => annotation.status !== "resolved").length
  return <Tabs value={tab} onValueChange={value => setTab(String(value))} className="h-full min-h-0 gap-0">
    <div className="flex shrink-0 items-center justify-between gap-2 p-4 pb-2">
      <TabsList aria-label="Document comments">
        <TabsTrigger value="comments">Comments <span className="text-xs text-muted-foreground">{openCount}</span></TabsTrigger>
        <TabsTrigger value="visitors">Visitors <span className="text-xs text-muted-foreground">{context.newCount}</span></TabsTrigger>
      </TabsList>
      {props.onClose && <Button variant="ghost" size="icon-sm" aria-label="Close comments" onClick={props.onClose}><X className="size-4" /></Button>}
    </div>
    <TabsContent value="comments" className="min-h-0"><AnnotationCommentsPanel {...props} header={false} /></TabsContent>
    <TabsContent value="visitors" className="min-h-0"><VisitorCommentsPanel context={context} onViewComment={annotation => { setTab("comments"); props.onSelectAnnotation(annotation) }} annotations={props.annotations} /></TabsContent>
  </Tabs>
}
