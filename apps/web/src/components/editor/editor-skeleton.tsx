import { Skeleton } from "@worktable/ui/components/skeleton";

export function EditorSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-20 pb-8 sm:px-8 md:px-12 space-y-6 animate-pulse">
      {/* Title skeleton — extra top padding accounts for BlockNote's
          internal block spacing above the first content element */}
      <div className="space-y-3">
        <Skeleton className="h-9 w-2/5 rounded-lg" />
      </div>

      {/* First paragraph */}
      <div className="space-y-2.5 pt-2">
        <Skeleton className="h-4 w-full rounded" />
        <Skeleton className="h-4 w-11/12 rounded" />
        <Skeleton className="h-4 w-3/4 rounded" />
      </div>

      {/* Second paragraph */}
      <div className="space-y-2.5 pt-3">
        <Skeleton className="h-4 w-full rounded" />
        <Skeleton className="h-4 w-5/6 rounded" />
        <Skeleton className="h-4 w-4/5 rounded" />
        <Skeleton className="h-4 w-2/3 rounded" />
      </div>

      {/* Subheading */}
      <div className="pt-4">
        <Skeleton className="h-6 w-1/4 rounded-lg" />
      </div>

      {/* List items */}
      <div className="space-y-3 pt-2 pl-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-2 w-2 rounded-full" />
          <Skeleton className="h-4 w-3/4 rounded" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-2 w-2 rounded-full" />
          <Skeleton className="h-4 w-2/3 rounded" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-2 w-2 rounded-full" />
          <Skeleton className="h-4 w-4/5 rounded" />
        </div>
      </div>

      {/* Code block skeleton */}
      <Skeleton className="h-28 w-full mt-4 rounded-lg" />

      {/* Final paragraph */}
      <div className="space-y-2.5 pt-2">
        <Skeleton className="h-4 w-full rounded" />
        <Skeleton className="h-4 w-5/6 rounded" />
      </div>
    </div>
  );
}
