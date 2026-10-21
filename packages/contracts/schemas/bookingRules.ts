import { z } from 'zod'
import { CHILD_SIDES } from '../constants/booking'
import { PRICE_TYPES, PRICE_UNITS } from '../constants/pricing'
import { isValidIsoDate, toEpochDay } from '../utils/dates'
import { isoDate, safeText, uuid } from './common'

/** Money in integer halalas (1 SAR = 100); bounded so per-night totals stay well inside 32-bit integers. */
export const halalas = z.number().int().min(0).max(100_000_000)

/** The hotel-level booking rules staff manage (v7 §15), one URL segment each. */
export const BOOKING_RULE_KINDS = ['rates', 'agency-quotas', 'allocation-rules', 'extra-bed-policies'] as const
export type BookingRuleKind = typeof BOOKING_RULE_KINDS[number]

/** An inclusive season `[startDate, endDate]` must not end before it starts. */
function seasonOrder(body: { startDate?: unknown, endDate?: unknown }, ctx: z.RefinementCtx): void {
  const { startDate, endDate } = body
  if (typeof startDate === 'string' && typeof endDate === 'string' && isValidIsoDate(startDate) && isValidIsoDate(endDate) && toEpochDay(endDate) < toEpochDay(startDate)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: '"endDate" must not be before "startDate"' })
  }
}

/** Public price, or the optional default for every approved agency, per room type and season (v7 §8). */
const rateFields = z.object({
  roomTypeId: uuid,
  priceType: z.enum(PRICE_TYPES),
  unit: z.enum(PRICE_UNITS),
  startDate: isoDate,
  endDate: isoDate,
  amountHalalas: halalas,
  vatIncluded: z.boolean(),
}).strict()
export const rateSchema = rateFields.superRefine(seasonOrder)

/** Persons per night an agency may hold in the hotel during a season; `agencyId: null` = the default for every agency (v7 §10). */
const agencyQuotaFields = z.object({
  agencyId: uuid.nullable(),
  startDate: isoDate,
  endDate: isoDate,
  maxPersons: z.number().int().min(0).max(100_000),
}).strict()
export const agencyQuotaSchema = agencyQuotaFields.superRefine(seasonOrder)

/** Room-mix cap for a group size range (per gender): at most `maxRooms` rooms with `minSeats` or more seats (v7 §5). */
const allocationRuleFields = z.object({
  groupMin: z.number().int().min(1).max(10_000),
  groupMax: z.number().int().min(1).max(10_000).nullable(),
  minSeats: z.number().int().min(1).max(30),
  maxRooms: z.number().int().min(0).max(10_000),
}).strict()
export const allocationRuleSchema = allocationRuleFields.superRefine((body, ctx) => {
  if (body.groupMax !== null && body.groupMax < body.groupMin) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['groupMax'], message: '"groupMax" must not be below "groupMin"' })
})

/** Extra beds for one room type: limits, price, and whether seasonally overridden rooms may get them (v7 §11). */
export const extraBedPolicySchema = z.object({
  roomTypeId: uuid,
  maxPerRoom: z.number().int().min(0).max(5),
  maxPerBooking: z.number().int().min(0).max(1_000),
  amountHalalas: halalas,
  vatIncluded: z.boolean(),
  allowInOverrideSeason: z.boolean(),
}).strict()

/** The editable fields of each rule kind (what a PATCH may carry and what is merged from the stored rule). */
export const BOOKING_RULE_FIELDS = {
  'rates': rateFields,
  'agency-quotas': agencyQuotaFields,
  'allocation-rules': allocationRuleFields,
  'extra-bed-policies': extraBedPolicySchema,
} as const satisfies Record<BookingRuleKind, z.AnyZodObject>

/** The full body of each rule kind (a PATCH is merged onto the stored rule, then validated with this). */
export const BOOKING_RULE_SCHEMAS = {
  'rates': rateSchema,
  'agency-quotas': agencyQuotaSchema,
  'allocation-rules': allocationRuleSchema,
  'extra-bed-policies': extraBedPolicySchema,
} as const satisfies Record<BookingRuleKind, z.ZodTypeAny>

export type RateInput = z.infer<typeof rateSchema>
export type AgencyQuotaInput = z.infer<typeof agencyQuotaSchema>
export type AllocationRuleInput = z.infer<typeof allocationRuleSchema>
export type ExtraBedPolicyInput = z.infer<typeof extraBedPolicySchema>

/** `PATCH /api/booking-settings` — organization-wide booking settings (v7 §15); every field optional. */
export const bookingSettingsPatchSchema = z.object({
  holdMinutes: z.number().int().min(1).max(120),
  requestHours: z.number().int().min(1).max(168),
  quoteValidityHours: z.number().int().min(1).max(720),
  individualMaxRooms: z.number().int().min(1).max(50),
  individualMaxOpenRequests: z.number().int().min(1).max(10),
  childAgeLimit: z.number().int().min(1).max(18),
  infantAgeLimit: z.number().int().min(1).max(5),
  childDefaultSide: z.enum(CHILD_SIDES),
  passportMinValidityMonths: z.number().int().min(0).max(24),
  detailsReminderDays: z.number().int().min(0).max(60),
  passportImageRetentionMonths: z.number().int().min(1).max(120),
  /** International digits without "+" (the wa.me format), e.g. 9665XXXXXXXX. */
  whatsappNumber: z.string().regex(/^[1-9]\d{7,14}$/, 'Digits only, with the country code (e.g. 9665XXXXXXXX)').nullable(),
  whatsappTemplate: safeText(1000).nullable(),
}).partial().strict().refine(body => Object.keys(body).length > 0, 'Nothing to change')
export type BookingSettingsPatch = z.infer<typeof bookingSettingsPatchSchema>
