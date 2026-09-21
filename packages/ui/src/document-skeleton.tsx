import { Skeleton } from "./components/skeleton"

export function DocumentSkeleton() {
  return (
    <div
      data-document-loading="true"
      role="status"
      aria-label="Opening document"
      className="mx-auto w-full max-w-3xl space-y-6 px-6 pt-20 pb-8 sm:px-8 md:px-12"
    >
      {/* Title skeleton — extra top padding accounts for BlockNote's
          internal block spacing above the first content element */}
      <div className="space-y-3">
        <Skeleton className="h-9 w-2/5 rounded-lg motion-reduce:animate-none" />
      </div>

      {/* First paragraph */}
      <div className="space-y-2.5 pt-2">
        <Skeleton className="h-4 w-full rounded motion-reduce:animate-none" />
        <Skeleton className="h-4 w-11/12 rounded motion-reduce:animate-none" />
        <Skeleton className="h-4 w-3/4 rounded motion-reduce:animate-none" />
      </div>

      {/* Second paragraph */}
      <div className="space-y-2.5 pt-3">
        <Skeleton className="h-4 w-full rounded motion-reduce:animate-none" />
        <Skeleton className="h-4 w-5/6 rounded motion-reduce:animate-none" />
        <Skeleton className="h-4 w-4/5 rounded motion-reduce:animate-none" />
        <Skeleton className="h-4 w-2/3 rounded motion-reduce:animate-none" />
      </div>

      {/* Subheading */}
      <div className="pt-4">
        <Skeleton className="h-6 w-1/4 rounded-lg motion-reduce:animate-none" />
      </div>

      {/* List items */}
      <div className="space-y-3 pt-2 pl-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-2 w-2 rounded-full motion-reduce:animate-none" />
          <Skeleton className="h-4 w-3/4 rounded motion-reduce:animate-none" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-2 w-2 rounded-full motion-reduce:animate-none" />
          <Skeleton className="h-4 w-2/3 rounded motion-reduce:animate-none" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-2 w-2 rounded-full motion-reduce:animate-none" />
          <Skeleton className="h-4 w-4/5 rounded motion-reduce:animate-none" />
        </div>
      </div>

      {/* Code block skeleton */}
      <Skeleton className="mt-4 h-28 w-full rounded-lg motion-reduce:animate-none" />

      {/* Final paragraph */}
      <div className="space-y-2.5 pt-2">
        <Skeleton className="h-4 w-full rounded motion-reduce:animate-none" />
        <Skeleton className="h-4 w-5/6 rounded motion-reduce:animate-none" />
      </div>
    </div>
  )
}
