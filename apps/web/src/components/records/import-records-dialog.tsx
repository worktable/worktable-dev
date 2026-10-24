import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@worktable/ui/components/button"
import { Checkbox } from "@worktable/ui/components/checkbox"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { toast } from "@worktable/ui/components/sonner"
import { queryKeys } from "@/lib/queries"
import {
  importIntoRecords,
  proposeRecordsImport,
  type ImportColumn,
  type ImportFieldType,
} from "@/lib/records-import-api"

const TYPE_LABELS: Record<ImportFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Yes/No",
}

const NO_ID = "\u0000none"

function collectionIdFor(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "collection"
  )
}

interface ColumnChoice extends ImportColumn {
  included: boolean
}

/**
 * Import a CSV, TSV or JSONL file into a Record collection: choose the
 * columns to keep, their fields and types, and the column that names rows.
 */
export function ImportRecordsDialog({
  open,
  onClose,
  spaceId,
  path,
  fileName,
}: {
  open: boolean
  onClose: () => void
  spaceId: string
  path: string
  fileName: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const defaultName = fileName.replace(/\.[^.]+$/, "")
  const [name, setName] = useState(defaultName)
  const [choices, setChoices] = useState<ColumnChoice[]>([])
  const [idColumn, setIdColumn] = useState<string>(NO_ID)
  const [titleColumn, setTitleColumn] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const proposal = useQuery({
    queryKey: ["records-import-proposal", spaceId, path],
    queryFn: () =>
      proposeRecordsImport(spaceId, collectionIdFor(defaultName), path),
    enabled: open,
    staleTime: 0,
  })

  useEffect(() => {
    if (!open || !proposal.data) return
    setChoices(
      proposal.data.columns.map((column) => ({
        ...column,
        included: column.column !== proposal.data.idColumn,
      }))
    )
    setIdColumn(proposal.data.idColumn ?? NO_ID)
    setTitleColumn(proposal.data.titleColumn ?? null)
  }, [open, proposal.data])

  useEffect(() => {
    if (open) setName(defaultName)
  }, [open, defaultName])

  const included = useMemo(
    () => choices.filter((choice) => choice.included),
    [choices]
  )
  // A record is named by one of the text columns it keeps.
  const titleChoices = included.filter((choice) => choice.type === "text")
  const title = titleChoices.some((choice) => choice.column === titleColumn)
    ? titleColumn
    : (titleChoices[0]?.column ?? null)
  const idColumns = proposal.data?.idColumns ?? []

  const update = (index: number, change: Partial<ColumnChoice>) =>
    setChoices((current) =>
      current.map((choice, i) => (i === index ? { ...choice, ...change } : choice))
    )

  const submit = async () => {
    const collectionId = collectionIdFor(name)
    setImporting(true)
    try {
      const result = await importIntoRecords(spaceId, collectionId, {
        path,
        columns: included.map(({ column, field, type }) => ({ column, field, type })),
        ...(idColumn !== NO_ID ? { idColumn } : {}),
        ...(title ? { titleColumn: title } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      })
      // The collection list and the imported collection, as the server's
      // record_collection_update refreshes them; other collections stay.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.recordCollections(spaceId),
        exact: true,
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.records(spaceId, collectionId),
      })
      onClose()
      void navigate({
        to: "/spaces/$spaceId/records/$",
        params: { spaceId, _splat: collectionId },
      })
      const { created, skipped, failed } = result.counts
      const imported = `Imported ${created} ${created === 1 ? "row" : "rows"}`
      if (failed > 0) {
        // Rows that weren't written are named, so the import can be fixed.
        const first = result.rows.find((row) => row.error)
        toast.error(
          `${imported}; ${failed} ${failed === 1 ? "row" : "rows"} failed`,
          first ? { description: `Row ${first.row}: ${first.error}` } : undefined
        )
      } else {
        toast.success(
          skipped > 0 ? `${imported}; ${skipped} were already there` : imported
        )
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t import the file")
    } finally {
      setImporting(false)
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => !next && !importing && onClose()}
    >
      <ResponsiveDialogContent ref={setContainer} className="sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Import into Records</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {proposal.data
              ? `${proposal.data.rowCount.toLocaleString()} ${proposal.data.rowCount === 1 ? "row" : "rows"} from ${fileName}. The file stays as it is.`
              : `From ${fileName}. The file stays as it is.`}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="flex flex-col gap-4">
          {proposal.isError ? (
            <p className="text-sm text-destructive">
              {proposal.error instanceof Error
                ? proposal.error.message
                : "Couldn’t read the file"}
            </p>
          ) : null}
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Collection</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={importing}
            />
          </label>
          <div className="flex flex-col gap-2 text-sm">
            <span id="import-id-column" className="font-medium">
              Row id
            </span>
            <Select
              value={idColumn}
              disabled={importing || idColumns.length === 0}
              onValueChange={(value) => {
                if (value) setIdColumn(value)
              }}
            >
              <SelectTrigger aria-labelledby="import-id-column" className="h-10 w-full">
                <SelectValue>
                  {idColumn === NO_ID ? "None: every import adds rows" : idColumn}
                </SelectValue>
              </SelectTrigger>
              <SelectContent container={container}>
                <SelectItem value={NO_ID}>None: every import adds rows</SelectItem>
                {idColumns.map((column) => (
                  <SelectItem key={column} value={column}>
                    {column}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {proposal.data && idColumns.length === 0 ? (
              <p className="text-muted-foreground">
                No column has a usable id for every row.
              </p>
            ) : null}
          </div>
          {titleChoices.length > 0 ? (
            <div className="flex flex-col gap-2 text-sm">
              <span id="import-title-column" className="font-medium">
                Title
              </span>
              <Select
                value={title}
                disabled={importing}
                onValueChange={(value) => {
                  if (value) setTitleColumn(value)
                }}
              >
                <SelectTrigger
                  aria-labelledby="import-title-column"
                  className="h-10 w-full"
                >
                  <SelectValue>{title}</SelectValue>
                </SelectTrigger>
                <SelectContent container={container}>
                  {titleChoices.map((choice) => (
                    <SelectItem key={choice.column} value={choice.column}>
                      {choice.column}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {choices.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Columns</span>
              <div className="flex flex-col gap-2">
                {choices.map((choice, index) => (
                  <div
                    key={choice.column}
                    className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_8rem] items-center gap-3 text-sm"
                  >
                    <Checkbox
                      aria-label={`Import ${choice.column}`}
                      checked={choice.included}
                      disabled={importing}
                      onCheckedChange={(checked) =>
                        update(index, { included: checked })
                      }
                    />
                    <span className="truncate" title={choice.column}>
                      {choice.column}
                    </span>
                    <Input
                      aria-label={`Field for ${choice.column}`}
                      value={choice.field}
                      disabled={importing || !choice.included}
                      onChange={(event) =>
                        update(index, { field: event.target.value })
                      }
                    />
                    <Select
                      value={choice.type}
                      disabled={importing || !choice.included}
                      onValueChange={(value) => {
                        if (value) update(index, { type: value as ImportFieldType })
                      }}
                    >
                      <SelectTrigger
                        aria-label={`Type of ${choice.column}`}
                        className="h-9 w-full"
                      >
                        <SelectValue>{TYPE_LABELS[choice.type]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent container={container}>
                        {(Object.keys(TYPE_LABELS) as ImportFieldType[]).map((type) => (
                          <SelectItem key={type} value={type}>
                            {TYPE_LABELS[type]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">
                Keep only the columns the team will use. Columns left out stay
                in the file.
              </p>
            </div>
          ) : null}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={importing || !proposal.data || included.length === 0}
          >
            {importing ? "Importing…" : "Import"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
