import { z } from 'zod'
import { isValidIsoDate, toEpochDay } from '../utils/dates'

/** The longest stay a quote or booking may cover (a Hajj/Umrah season is far shorter). */
export const MAX_STAY_NIGHTS = 120

/** A stay `[checkIn, checkOut)`: at least one night, at most `MAX_STAY_NIGHTS` (date format is checked by the fields). */
export function addStayDateIssues(body: { checkIn: string, checkOut: string }, ctx: z.RefinementCtx): void {
  if (!isValidIsoDate(body.checkIn) || !isValidIsoDate(body.checkOut)) return
  const nights = toEpochDay(body.checkOut) - toEpochDay(body.checkIn)
  if (nights < 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checkOut'], message: '"checkOut" must be after "checkIn"' })
  if (nights > MAX_STAY_NIGHTS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checkOut'], message: `A stay may not exceed ${MAX_STAY_NIGHTS} nights` })
}
