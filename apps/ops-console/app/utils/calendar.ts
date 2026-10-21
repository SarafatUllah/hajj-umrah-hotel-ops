import { addDays, isValidIsoDate, type NightRange, toEpochDay } from '@hajj/contracts/utils/dates'

/** The zoom presets (§31.3): nights shown and each night's column width. */
export const ZOOMS = [7, 14, 31, 90] as const
export type Zoom = typeof ZOOMS[number]
export const COLUMN_WIDTH: Record<Zoom, number> = { 7: 128, 14: 72, 31: 36, 90: 16 }
/** Bar widths from which a bar shows its label and capacity, or only the capacity number (§31.2). */
const FULL_FROM_PX = 96
const NUMBER_FROM_PX = 28
const FRIDAY = 5
const SATURDAY = 6

/** The nights a calendar shows. */
export interface CalendarRange { from: string, to: string, nights: number }

/**
 * The nights shown: from the chosen first night (when it is a real date), else yesterday — so tonight has a night of
 * context before it. `null` while the hotel's today is not known yet and no first night is chosen.
 */
export function calendarRange(view: { today: string, from: string | undefined, nights: number }): CalendarRange | null {
  const from = view.from && isValidIsoDate(view.from) ? view.from : view.today && addDays(view.today, -1)
  return from ? { from, to: addDays(from, view.nights - 1), nights: view.nights } : null
}

/** Where a run of nights sits in the grid (1-based column and span), clipped to the range; `null` when outside it. */
export function placeOf(segment: NightRange, from: string, nights: number): { column: number, span: number } | null {
  const start = toEpochDay(from)
  const first = Math.max(toEpochDay(segment.from) - start, 0)
  const last = Math.min(toEpochDay(segment.to) - start, nights - 1)
  return last < first ? null : { column: first + 1, span: last - first + 1 }
}

/**
 * Which night of a bar a click fell on, counted from the bar's first night: from where in the bar (its leading edge
 * is the right one in Arabic), whatever part of it — icon, label — took the click.
 */
export function nightIndexAt(click: { x: number, left: number, right: number, rtl: boolean }, columnWidth: number, span: number): number {
  const offset = click.rtl ? click.right - click.x : click.x - click.left
  return Math.min(Math.max(Math.floor(offset / columnWidth), 0), span - 1)
}

/** What a bar shows at its width: icon, label and capacity; icon and number; or only its fill. */
export function barContent(span: number, columnWidth: number): 'full' | 'number' | 'none' {
  const width = span * columnWidth
  if (width >= FULL_FROM_PX) return 'full'
  return width >= NUMBER_FROM_PX ? 'number' : 'none'
}

/** The months over the range, each with the columns it covers (`month` as YYYY-MM). */
export function monthsOf(from: string, nights: number): Array<{ month: string, column: number, span: number }> {
  const months: Array<{ month: string, column: number, span: number }> = []
  for (let night = 0; night < nights; night++) {
    const month = addDays(from, night).slice(0, 7)
    const current = months.at(-1)
    if (current?.month === month) current.span += 1
    else months.push({ month, column: night + 1, span: 1 })
  }
  return months
}

/** The weekend columns (Friday and Saturday at Saudi hotels), 1-based. */
export function weekendColumns(from: string, nights: number): number[] {
  return Array.from({ length: nights }, (_, night) => night).filter((night) => {
    const weekday = new Date(`${addDays(from, night)}T00:00:00Z`).getUTCDay()
    return weekday === FRIDAY || weekday === SATURDAY
  }).map(night => night + 1)
}

export interface CalendarCell { row: number, night: number }

/**
 * The active cell after a key (§31.4): arrows move by a night or a room — mirrored when the page reads right to
 * left, where later nights are further left — Home/End go to the first or last night. `null`: not a moving key.
 */
export function moveCell(cell: CalendarCell, key: string, grid: { rows: number, nights: number, rtl: boolean }): CalendarCell | null {
  const clamp = (value: number, size: number) => Math.min(Math.max(value, 0), size - 1)
  const later = grid.rtl ? 'ArrowLeft' : 'ArrowRight'
  const earlier = grid.rtl ? 'ArrowRight' : 'ArrowLeft'
  if (key === later) return { ...cell, night: clamp(cell.night + 1, grid.nights) }
  if (key === earlier) return { ...cell, night: clamp(cell.night - 1, grid.nights) }
  if (key === 'ArrowDown') return { ...cell, row: clamp(cell.row + 1, grid.rows) }
  if (key === 'ArrowUp') return { ...cell, row: clamp(cell.row - 1, grid.rows) }
  if (key === 'Home') return { ...cell, night: 0 }
  if (key === 'End') return { ...cell, night: grid.nights - 1 }
  return null
}
