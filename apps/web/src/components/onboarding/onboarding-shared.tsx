export function StepHeading({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  )
}
