/**
 * Colors that tell Worktables, Spaces and people apart. The theme defines a
 * light and dark value for each; they tint tiles and icons, never actions or
 * state.
 */
export const RECOGNITION_COLORS = [
  "teal",
  "sky",
  "violet",
  "rose",
  "orange",
  "amber",
  "green",
  "slate",
] as const;

export type RecognitionColor = (typeof RECOGNITION_COLORS)[number];

export function isRecognitionColor(value: unknown): value is RecognitionColor {
  return (
    typeof value === "string" &&
    (RECOGNITION_COLORS as readonly string[]).includes(value)
  );
}

/** A stable color for something nobody has chosen a color for yet. */
export function defaultRecognitionColor(seed: string): RecognitionColor {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  // Slate is for explicit choice; defaults use the hues.
  const hues = RECOGNITION_COLORS.length - 1;
  return RECOGNITION_COLORS[Math.abs(hash) % hues];
}

/** The chosen color when it is one of ours, otherwise the default for `seed`. */
export function recognitionColor(
  chosen: unknown,
  seed: string
): RecognitionColor {
  return isRecognitionColor(chosen) ? chosen : defaultRecognitionColor(seed);
}
