import { describe, expect, it } from 'vitest'
import type { BookingSettingsDto } from '@hajj/contracts/types/bookingRules'
import { ageLimitsAgree, bookingSettingsFormOf, bookingSettingsPatchOf, bookingSettingsRequestOf } from '../app/utils/bookingSettings'

const SAVED: BookingSettingsDto = {
  holdMinutes: 10, requestHours: 24, quoteValidityHours: 48, individualMaxRooms: 5, individualMaxOpenRequests: 1,
  childAgeLimit: 10, infantAgeLimit: 2, childDefaultSide: 'MOTHER', passportMinValidityMonths: 6, detailsReminderDays: 7,
  passportImageRetentionMonths: 12, passportAiAllowed: false, guestDataRetentionMonths: 24, noShowReleasesSeats: false,
  whatsappNumber: null, whatsappTemplate: 'Salam {ref}', updatedAt: '2026-10-21T10:00:00.000Z',
}

describe('the booking settings form (v7 §15)', () => {
  it('shows the saved settings, an unset WhatsApp field as empty text', () => {
    const form = bookingSettingsFormOf(SAVED)
    expect(form).toMatchObject({ holdMinutes: 10, whatsappNumber: '', whatsappTemplate: 'Salam {ref}' })
    expect(form).not.toHaveProperty('updatedAt')
  })

  it('sends only what changed — nothing when nothing did', () => {
    const form = bookingSettingsFormOf(SAVED)
    expect(bookingSettingsPatchOf(form, SAVED)).toEqual({})
    expect(bookingSettingsPatchOf({ ...form, holdMinutes: 15, passportAiAllowed: true }, SAVED)).toEqual({ holdMinutes: 15, passportAiAllowed: true })
  })

  it('a WhatsApp field is trimmed, and emptied it is none', () => {
    const form = bookingSettingsFormOf(SAVED)
    expect(bookingSettingsPatchOf({ ...form, whatsappNumber: ' 966500000000 ', whatsappTemplate: '  ' }, SAVED)).toEqual({ whatsappNumber: '966500000000', whatsappTemplate: null })
    expect(bookingSettingsPatchOf({ ...form, whatsappTemplate: 'Salam {ref} ' }, SAVED)).toEqual({})
  })

  it('a cleared number is none (the field says required), never a change left out', () => {
    const form = bookingSettingsFormOf(SAVED)
    const cleared = { ...form, holdMinutes: null as unknown as number, requestHours: Number.NaN }
    expect(bookingSettingsRequestOf(cleared)).toMatchObject({ holdMinutes: null, requestHours: null })
    expect(bookingSettingsPatchOf(cleared, SAVED)).toEqual({ holdMinutes: null, requestHours: null })
  })

  it('an infant is never older than a child (a cleared age is left to the field\'s own check)', () => {
    expect(ageLimitsAgree({ childAgeLimit: 10, infantAgeLimit: 2 })).toBe(true)
    expect(ageLimitsAgree({ childAgeLimit: 2, infantAgeLimit: 2 })).toBe(true)
    expect(ageLimitsAgree({ childAgeLimit: 2, infantAgeLimit: 3 })).toBe(false)
    expect(ageLimitsAgree({ childAgeLimit: null as unknown as number, infantAgeLimit: 3 })).toBe(true)
  })
})
