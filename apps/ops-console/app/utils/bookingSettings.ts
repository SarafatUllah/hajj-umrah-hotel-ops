import type { ChildSide } from '@hajj/contracts/constants/booking'
import type { BookingSettingsPatch } from '@hajj/contracts/schemas/bookingRules'
import type { BookingSettingsDto } from '@hajj/contracts/types/bookingRules'
import { typedNumber } from './forms'

/** The booking settings as the form holds them (v7 §15): numbers, switches, and the WhatsApp fields as text (empty: none). */
export interface BookingSettingsForm {
  holdMinutes: number
  requestHours: number
  quoteValidityHours: number
  individualMaxRooms: number
  individualMaxOpenRequests: number
  childAgeLimit: number
  infantAgeLimit: number
  childDefaultSide: ChildSide
  passportMinValidityMonths: number
  detailsReminderDays: number
  passportImageRetentionMonths: number
  passportAiAllowed: boolean
  guestDataRetentionMonths: number
  noShowReleasesSeats: boolean
  whatsappNumber: string
  whatsappTemplate: string
}

/** The saved settings as the form shows them. */
export function bookingSettingsFormOf(settings: BookingSettingsDto): BookingSettingsForm {
  const { updatedAt: _updatedAt, whatsappNumber, whatsappTemplate, ...rest } = settings
  return { ...rest, whatsappNumber: whatsappNumber ?? '', whatsappTemplate: whatsappTemplate ?? '' }
}

/** The settings typed as numbers (a cleared one is none, so its field says "required"). */
const NUMBER_SETTINGS = [
  'holdMinutes', 'requestHours', 'quoteValidityHours', 'individualMaxRooms', 'individualMaxOpenRequests', 'childAgeLimit',
  'infantAgeLimit', 'passportMinValidityMonths', 'detailsReminderDays', 'passportImageRetentionMonths', 'guestDataRetentionMonths',
] as const satisfies ReadonlyArray<keyof BookingSettingsForm>

/** Every setting as the request carries it (to validate, and to compare): a cleared number and an empty WhatsApp field are none. */
export function bookingSettingsRequestOf(form: BookingSettingsForm): Record<keyof BookingSettingsForm, unknown> {
  const numbers = Object.fromEntries(NUMBER_SETTINGS.map(key => [key, typedNumber(form[key]) ?? null]))
  return { ...form, ...numbers, whatsappNumber: form.whatsappNumber.trim() || null, whatsappTemplate: form.whatsappTemplate.trim() || null }
}

/** `PATCH /api/booking-settings`: only what changed (empty when nothing did). */
export function bookingSettingsPatchOf(form: BookingSettingsForm, saved: BookingSettingsDto): BookingSettingsPatch {
  const before = bookingSettingsRequestOf(bookingSettingsFormOf(saved))
  const after = bookingSettingsRequestOf(form)
  const keys = Object.keys(after) as Array<keyof BookingSettingsForm>
  return Object.fromEntries(keys.filter(key => after[key] !== before[key]).map(key => [key, after[key]])) as BookingSettingsPatch
}

/** The ages agree (the API's rule, said under the infant age before saving): an infant is never older than a child. */
export function ageLimitsAgree(form: Pick<BookingSettingsForm, 'childAgeLimit' | 'infantAgeLimit'>): boolean {
  return typeof form.childAgeLimit !== 'number' || typeof form.infantAgeLimit !== 'number' || form.infantAgeLimit <= form.childAgeLimit
}
