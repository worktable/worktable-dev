import { useEffect, useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, Trash } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import {
  CanonicalIdSchema,
  type RecordCollectionSchema,
  type RecordFile,
} from "@worktable/types"
import {
  RecordDetailBody,
  type RecordPeekActions,
} from "@/components/records/record-peek"
import { DocumentReferenceScope } from "@/components/records/field-value"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { usePageMeta } from "@/hooks/use-page-meta"
import { queryKeys, useRecordCollectionHealth } from "@/lib/queries"
import { readRecord } from "@/lib/records-api"
import { useRecordMutations } from "@/lib/records-queries"
import { indexDanglingRelations, recordTitle } from "@/lib/records"

export const Route = createFileRoute(
  "/spaces/$spaceId/records/$collectionId/$recordId"
)({
  ssr: false,
  component: FullRecordPage,
})

function FullRecordPage() {
  const { spaceId, collectionId, recordId } = Route.useParams()
  const navigate = Route.useNavigate()
  const valid =
    CanonicalIdSchema.safeParse(collectionId).success &&
    CanonicalIdSchema.safeParse(recordId).success
  const { data: health } = useRecordCollectionHealth(spaceId, collectionId)
  const recordQuery = useQuery({
    queryKey: [...queryKeys.records(spaceId, collectionId), "record", recordId],
    queryFn: () => readRecord(spaceId, collectionId, recordId),
    enabled: valid,
  })
  const mutations = useRecordMutations(spaceId, collectionId)
  const [deleteTarget, setDeleteTarget] = useState<RecordFile | null>(null)
  const scrollRef = useScrollFade<HTMLDivElement>(8, { top: false })
  const back = () =>
    void navigate({
      to: "/spaces/$spaceId/records/$",
      params: { spaceId, _splat: collectionId },
    })
  const actions = useMemo<RecordPeekActions>(
    () => ({
      onCommitField: (id, key, value) =>
        mutations.updateField.mutate({ recordId: id, data: { [key]: value } }),
      onDuplicate: (record) =>
        void mutations.duplicate.mutateAsync(record).then((created) =>
          navigate({
            to: "/spaces/$spaceId/records/$collectionId/$recordId",
            params: { spaceId, collectionId, recordId: created.recordId },
          })
        ),
      onArchive: (id) => mutations.archive.mutate(id),
      onRestore: (id) => mutations.restore.mutate(id),
      onDelete: () => recordQuery.data && setDeleteTarget(recordQuery.data),
      // Mutation handles are stable for this collection.
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spaceId, collectionId, recordQuery.data]
  )
  const danglingByRecordField = useMemo(
    () => indexDanglingRelations(health?.integrityWarnings ?? []),
    [health?.integrityWarnings]
  )

  if (!valid || recordQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          This record does not exist.
        </p>
        <Button variant="outline" onClick={back}>
          <ArrowLeft className="mr-2 size-4" />
          Back to collection
        </Button>
      </div>
    )
  }
  if (!recordQuery.data)
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading record…
      </div>
    )
  const documentPaths = Object.entries(health?.schema?.fields ?? {}).flatMap(
    ([key, field]) => {
      if (field.type !== "document") return []
      const value = recordQuery.data.data[key]
      return typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string")
          : []
    }
  )
  return (
    <DocumentReferenceScope spaceId={spaceId} paths={documentPaths}>
      <FullRecordPageMeta
        record={recordQuery.data}
        collectionName={health?.schema?.name ?? collectionId}
        schema={health?.schema}
      />
      <div
        ref={scrollRef}
        className="scroll-fade h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-6 lg:px-8"
      >
        <div className="mx-auto mb-3 max-w-6xl">
          <Button variant="ghost" size="sm" onClick={back}>
            <ArrowLeft className="mr-2 size-4" />
            Back to collection
          </Button>
        </div>
        <article className="mx-auto min-h-[calc(100%-3rem)] max-w-6xl overflow-hidden rounded-2xl bg-card shadow-[0_20px_70px_-48px_var(--key-shadow)] ring-1 ring-border">
          <RecordDetailBody
            key={recordQuery.data.id}
            spaceId={spaceId}
            schema={health?.schema}
            record={recordQuery.data}
            actions={actions}
            danglingByRecordField={danglingByRecordField}
            surface="page"
            onClose={back}
          />
        </article>
        <ConfirmDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title="Delete record"
          variant="destructive"
          icon={<Trash className="size-5 text-destructive" />}
          description={
            <>
              Delete{" "}
              <span className="font-medium text-foreground">
                {deleteTarget ? recordTitle(deleteTarget, health?.schema) : ""}
              </span>
              ? This removes its YAML file and cannot be undone.
            </>
          }
          confirmLabel="Delete"
          loading={mutations.remove.isPending}
          onConfirm={async () => {
            if (!deleteTarget) return
            try {
              await mutations.remove.mutateAsync(deleteTarget.id)
              back()
            } catch {
              // Toasted by the mutation (the 409 message names restricting records).
            } finally {
              setDeleteTarget(null)
            }
          }}
        />
      </div>
    </DocumentReferenceScope>
  )
}

function FullRecordPageMeta({
  record,
  collectionName,
  schema,
}: {
  record: RecordFile
  collectionName: string
  schema?: RecordCollectionSchema
}) {
  const { setPageMeta } = usePageMeta()

  useEffect(() => {
    const updated = new Date(record.updatedAt)
    setPageMeta({
      updatedAtLabel: Number.isNaN(updated.getTime())
        ? "Updated recently"
        : `Updated ${updated.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
      provenanceLabel: `Record · ${record.collectionId}`,
      parentTitleOverride: collectionName,
      titleOverride: recordTitle(record, schema),
    })
    return () => setPageMeta(null)
  }, [collectionName, record, schema, setPageMeta])

  return null
}
