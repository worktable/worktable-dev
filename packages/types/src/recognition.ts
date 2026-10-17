/**
 * Colors that tell Worktables, Spaces and people apart. The theme defines a
 * light and dark value for each; they tint tiles and icons, never actions or
 * state.
 */
export const RECOGNITION_COLORS = [
  // Around the color wheel, so neighbours in this list are neighbours in hue.
  "orange",
  "amber",
  "olive",
  "green",
  "teal",
  "indigo",
  "violet",
  "rose",
  // A quiet gray, chosen deliberately rather than given by default.
  "slate",
] as const;

export type RecognitionColor = (typeof RECOGNITION_COLORS)[number];

export function isRecognitionColor(value: unknown): value is RecognitionColor {
  return (
    typeof value === "string" &&
    (RECOGNITION_COLORS as readonly string[]).includes(value)
  );
}

/** The colors given by default: every hue, leaving slate to be chosen. */
const HUES: readonly RecognitionColor[] = RECOGNITION_COLORS.filter(
  (color) => color !== "slate"
);

function seedHash(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/** A stable color for something nobody has chosen a color for yet. */
export function defaultRecognitionColor(seed: string): RecognitionColor {
  return HUES[seedHash(seed) % HUES.length];
}

/**
 * The color for something new among others that already have colors, such
 * as a new Space: the hue used least, and of those the one farthest around
 * the wheel from the hues used more. Spaces created one after another then
 * take every hue before any repeats, and neighbours differ. Ties go by
 * `seed`, so the pick is stable for the same inputs.
 */
export function spreadRecognitionColor(
  inUse: readonly unknown[],
  seed: string
): RecognitionColor {
  const counts = new Map<RecognitionColor, number>(HUES.map((hue) => [hue, 0]));
  for (const color of inUse) {
    if (isRecognitionColor(color) && counts.has(color)) {
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
  }
  const least = Math.min(...counts.values());
  const fewest = HUES.filter((hue) => counts.get(hue) === least);
  const busier = HUES.filter((hue) => (counts.get(hue) ?? 0) > least);
  const apart = (hue: RecognitionColor) => {
    if (busier.length === 0) return 0;
    const at = HUES.indexOf(hue);
    return Math.min(
      ...busier.map((other) => {
        const steps = Math.abs(at - HUES.indexOf(other));
        return Math.min(steps, HUES.length - steps);
      })
    );
  };
  const widest = Math.max(...fewest.map(apart));
  const candidates = fewest.filter((hue) => apart(hue) === widest);
  return candidates[seedHash(seed) % candidates.length];
}

/** The chosen color when it is one of ours, otherwise the default for `seed`. */
export function recognitionColor(
  chosen: unknown,
  seed: string
): RecognitionColor {
  return isRecognitionColor(chosen) ? chosen : defaultRecognitionColor(seed);
}
