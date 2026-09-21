import { useState } from "react"
import { cn } from "@worktable/ui/lib/utils"

interface QuadrantItem {
  name: string
  x: number
  y: number
  size?: number
  color?: string
  tooltip?: string
}

interface QuadrantLabels {
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
}

interface QuadrantChartProps {
  xLabel: string
  yLabel: string
  quadrantLabels: QuadrantLabels
  items: QuadrantItem[]
  className?: string
}

const VIEWBOX_W = 460
const VIEWBOX_H = 420
const PADDING_LEFT = 48
const PADDING_RIGHT = 16
const PADDING_TOP = 16
const PADDING_BOTTOM = 40
const CHART_W = VIEWBOX_W - PADDING_LEFT - PADDING_RIGHT
const CHART_H = VIEWBOX_H - PADDING_TOP - PADDING_BOTTOM

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

const TINTS = [
  "oklch(from var(--chart-1) l c h / 5%)",
  "oklch(from var(--chart-2) l c h / 7%)",
  "oklch(from var(--chart-3) l c h / 5%)",
  "oklch(from var(--chart-4) l c h / 6%)",
]

function QuadrantChart({
  xLabel,
  yLabel,
  quadrantLabels,
  items,
  className,
}: QuadrantChartProps) {
  const midX = PADDING_LEFT + CHART_W / 2
  const midY = PADDING_TOP + CHART_H / 2
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  return (
    <div
      className={cn("relative w-full", className)}
      style={{ aspectRatio: `${VIEWBOX_W} / ${VIEWBOX_H}` }}
    >
      <svg
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        className="h-auto w-full"
        aria-label="Quadrant positioning chart"
      >
        {/* Quadrant background fills */}
        <rect
          x={PADDING_LEFT}
          y={PADDING_TOP}
          width={CHART_W / 2}
          height={CHART_H / 2}
          fill={TINTS[0]}
        />
        <rect
          x={midX}
          y={PADDING_TOP}
          width={CHART_W / 2}
          height={CHART_H / 2}
          fill={TINTS[1]}
        />
        <rect
          x={PADDING_LEFT}
          y={midY}
          width={CHART_W / 2}
          height={CHART_H / 2}
          fill={TINTS[2]}
        />
        <rect
          x={midX}
          y={midY}
          width={CHART_W / 2}
          height={CHART_H / 2}
          fill={TINTS[3]}
        />

        {/* Chart border */}
        <rect
          x={PADDING_LEFT}
          y={PADDING_TOP}
          width={CHART_W}
          height={CHART_H}
          fill="none"
          className="stroke-border"
          strokeWidth="1"
        />

        {/* Dashed dividers */}
        <line
          x1={midX}
          y1={PADDING_TOP}
          x2={midX}
          y2={PADDING_TOP + CHART_H}
          className="stroke-border"
          strokeWidth="1"
          strokeDasharray="6 4"
        />
        <line
          x1={PADDING_LEFT}
          y1={midY}
          x2={PADDING_LEFT + CHART_W}
          y2={midY}
          className="stroke-border"
          strokeWidth="1"
          strokeDasharray="6 4"
        />

        {/* Quadrant labels (in corners) */}
        <text
          x={PADDING_LEFT + 8}
          y={PADDING_TOP + 16}
          className="fill-muted-foreground"
          fontSize="9"
          fontFamily="inherit"
          opacity="0.5"
        >
          {quadrantLabels.topLeft}
        </text>
        <text
          x={midX + 8}
          y={PADDING_TOP + 16}
          className="fill-muted-foreground"
          fontSize="9"
          fontFamily="inherit"
          opacity="0.5"
        >
          {quadrantLabels.topRight}
        </text>
        <text
          x={PADDING_LEFT + 8}
          y={midY + 16}
          className="fill-muted-foreground"
          fontSize="9"
          fontFamily="inherit"
          opacity="0.5"
        >
          {quadrantLabels.bottomLeft}
        </text>
        <text
          x={midX + 8}
          y={midY + 16}
          className="fill-muted-foreground"
          fontSize="9"
          fontFamily="inherit"
          opacity="0.5"
        >
          {quadrantLabels.bottomRight}
        </text>

        {/* X-axis: Low / High labels */}
        <text
          x={PADDING_LEFT + 4}
          y={PADDING_TOP + CHART_H + 14}
          className="fill-muted-foreground"
          fontSize="8"
          fontFamily="inherit"
          opacity="0.6"
        >
          Low
        </text>
        <text
          x={PADDING_LEFT + CHART_W - 4}
          y={PADDING_TOP + CHART_H + 14}
          className="fill-muted-foreground"
          fontSize="8"
          fontFamily="inherit"
          opacity="0.6"
          textAnchor="end"
        >
          High
        </text>
        {/* X-axis label centered below chart */}
        <text
          x={PADDING_LEFT + CHART_W / 2}
          y={VIEWBOX_H - 4}
          textAnchor="middle"
          className="fill-foreground"
          fontSize="11"
          fontFamily="inherit"
          fontWeight="600"
        >
          {xLabel}
        </text>

        {/* Y-axis: Low / High labels */}
        <text
          x={PADDING_LEFT - 8}
          y={PADDING_TOP + CHART_H - 2}
          textAnchor="end"
          className="fill-muted-foreground"
          fontSize="8"
          fontFamily="inherit"
          opacity="0.6"
        >
          Low
        </text>
        <text
          x={PADDING_LEFT - 8}
          y={PADDING_TOP + 10}
          textAnchor="end"
          className="fill-muted-foreground"
          fontSize="8"
          fontFamily="inherit"
          opacity="0.6"
        >
          High
        </text>
        {/* Y-axis label rotated on left */}
        <text
          x={12}
          y={PADDING_TOP + CHART_H / 2}
          textAnchor="middle"
          transform={`rotate(-90, 12, ${PADDING_TOP + CHART_H / 2})`}
          className="fill-foreground"
          fontSize="11"
          fontFamily="inherit"
          fontWeight="600"
        >
          {yLabel}
        </text>

        {/* Data points */}
        {items.map((item, i) => {
          const cx = PADDING_LEFT + (item.x / 100) * CHART_W
          const cy = PADDING_TOP + CHART_H - (item.y / 100) * CHART_H
          const r = item.size ? Math.max(5, item.size / 8) : 7
          const color = item.color ?? CHART_COLORS[i % CHART_COLORS.length]
          const isHovered = hoveredIdx === i

          return (
            <g
              key={i}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="cursor-pointer"
            >
              <title>{`${item.name} (${item.tooltip ?? `x:${item.x}, y:${item.y}`})`}</title>
              {/* Hover ring */}
              {isHovered && (
                <circle
                  cx={cx}
                  cy={cy}
                  r={r + 4}
                  fill="none"
                  stroke={color}
                  strokeWidth="1.5"
                  opacity="0.4"
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={color}
                opacity={isHovered ? 1 : 0.85}
              />
              {/* Label */}
              <text
                x={cx}
                y={cy - r - 4}
                textAnchor="middle"
                fontSize="8"
                fontFamily="inherit"
                fontWeight="600"
                className="fill-foreground"
              >
                {item.name}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export { QuadrantChart }
export type { QuadrantChartProps, QuadrantItem, QuadrantLabels }
