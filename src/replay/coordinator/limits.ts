/** Public numeric knobs must never disable bounds through NaN, Infinity, or fractions. */
export function finiteInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value!)))
    : fallback;
}
