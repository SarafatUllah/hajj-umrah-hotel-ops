/** Translates a message key with named arguments (`useI18n().t`). */
type Translate = (key: string, named?: Record<string, unknown>) => string

/** A floor's level as people say it (§25): "Ground" for 0, "B1", "B2" below, the number above. */
export function levelName(level: number, t: Translate): string {
  if (level === 0) return t('floors.ground')
  return level < 0 ? t('floors.basement', { n: -level }) : String(level)
}

/** The levels a bulk creation would add, in order (none when the range is reversed). */
export function floorLevels(fromLevel: number, toLevel: number): number[] {
  return toLevel < fromLevel ? [] : Array.from({ length: toLevel - fromLevel + 1 }, (_, index) => fromLevel + index)
}
