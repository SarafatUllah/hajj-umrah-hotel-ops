const MS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
/** Hours are counted up to two days; beyond that, days read better ("3 days left"). */
const HOURS_SHOWN_UNTIL = 48
/** Within a day a hold turns from information to a warning (§36). */
const URGENT_WITHIN_HOURS = 24

export interface HoldLeft { unit: 'minute' | 'hour' | 'day', count: number, urgent: boolean }

/** What is left of a hold at `now` (ms): minutes (rounded up), else whole hours, else whole days. */
export function holdLeft(until: string, now: number): HoldLeft {
  const minutes = Math.max(0, Math.ceil((Date.parse(until) - now) / MS_PER_MINUTE))
  const urgent = minutes < URGENT_WITHIN_HOURS * MINUTES_PER_HOUR
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  if (hours < 1) return { unit: 'minute', count: minutes, urgent }
  if (hours < HOURS_SHOWN_UNTIL) return { unit: 'hour', count: hours, urgent }
  return { unit: 'day', count: Math.floor(hours / HOURS_PER_DAY), urgent }
}
