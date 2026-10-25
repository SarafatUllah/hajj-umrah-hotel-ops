import { z } from 'zod'
import { GENDERS } from '../constants/booking'
import { isoDate, safeText } from './common'

/** A passport number as printed: letters and digits (spaces and dashes are dropped), 5–20 characters. */
export const passportNumber = z.string()
  // ASCII only BEFORE folding case: `ß`, `ſ` or `ﬁ` would otherwise upper-case into other letters and collide.
  .refine(value => /^[A-Za-z0-9\s-]{5,40}$/.test(value), { message: 'A passport number has 5–20 letters and digits' })
  .transform(value => value.replace(/[\s-]/g, '').toUpperCase())
  .refine(value => /^[A-Z0-9]{5,20}$/.test(value), { message: 'A passport number has 5–20 letters and digits' })

/** ICAO 9303 three-letter nationality (as in the MRZ): BGD, PAK, IDN … */
export const nationalityCode = z.string().trim().refine(value => /^[A-Za-z]{3}$/.test(value), { message: 'Use the three-letter code from the passport (e.g. BGD)' }).transform(value => value.toUpperCase())

/**
 * One pilgrim's details for a booking slot (v7 §7, §13), entered by hand or confirmed from a passport scan's review
 * form. Only the name is needed to save; the slot is READY (check-in possible) once name, gender, nationality, date of
 * birth, passport number and expiry are all there. The extras are printed-page fields (encrypted at rest).
 */
export const guestDetailsSchema = z.object({
  fullName: safeText(120).refine(value => value.length >= 2, 'Enter the full name'),
  gender: z.enum(GENDERS).optional(),
  nationality: nationalityCode.optional(),
  dateOfBirth: isoDate.optional(),
  passportNo: passportNumber.optional(),
  passportExpiry: isoDate.optional(),
  extras: z.object({
    address: safeText(300).optional(),
    placeOfBirth: safeText(120).optional(),
    passportIssueDate: isoDate.optional(),
    issuingAuthority: safeText(120).optional(),
    phone: safeText(30).optional(),
  }).strict().optional(),
}).strict().superRefine((body, ctx) => {
  // The passport's blind index is nationality + number: a number alone cannot be matched or stored.
  if (body.passportNo && !body.nationality) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nationality'], message: 'Give the nationality with the passport number' })
})
export type GuestDetailsInput = z.infer<typeof guestDetailsSchema>

/** `GET /api/bookings/:id/guests?reveal=passport`: staff with `pilgrim.viewSensitive` see full passport numbers (logged). */
export const listGuestsQuerySchema = z.object({ reveal: z.enum(['passport']).optional() })
export type ListGuestsQuery = z.infer<typeof listGuestsQuerySchema>

/** What a complete passport entry gives (the slot is READY with all of them). */
const PASSPORT_FIELDS = ['gender', 'nationality', 'dateOfBirth', 'passportNo', 'passportExpiry'] as const

/**
 * v7 §6 (public site): a request carries at least one pilgrim's passport — the lead pilgrim (a family's father, say),
 * with every passport field.
 */
export const leadPilgrimSchema = guestDetailsSchema.superRefine((body, ctx) => {
  for (const field of PASSPORT_FIELDS) {
    if (!body[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Required for the lead pilgrim' })
  }
})
export type LeadPilgrimInput = z.infer<typeof leadPilgrimSchema>
