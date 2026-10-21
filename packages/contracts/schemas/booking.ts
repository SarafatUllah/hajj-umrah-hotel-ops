import { z } from 'zod'
import { BOOKING_STATUSES, BOOKING_TYPES, CHILD_SIDES, OCCUPANCIES } from '../constants/booking'
import { isoDate, pagination, safeText, uuid } from './common'
import { addStayDateIssues } from './stay'

/** The most seated pilgrims in one booking (two 300-pilgrim sides; keeps the allocator well under 100 ms per side). */
export const MAX_BOOKING_PILGRIMS = 600
/** The most rooms one booking may claim. */
export const MAX_BOOKING_ROOMS = 200

const counts = z.number().int().min(0).max(MAX_BOOKING_PILGRIMS)

/**
 * Who stays where and when (v7 §5–7): GROUP gives men, women and children under the child age (each on a parent's
 * side, default the mother's); FAMILY gives only the seated total. Infants (under 2) take no seat and are counted
 * apart. `quoteId`: the agency's offered quote to book at (v7 §8).
 */
const stayFields = {
  hotelId: uuid,
  bookingType: z.enum(BOOKING_TYPES),
  checkIn: isoDate,
  checkOut: isoDate,
  maleCount: counts.default(0),
  femaleCount: counts.default(0),
  childCount: counts.default(0),
  infantCount: z.number().int().min(0).max(100).default(0),
  totalCount: z.number().int().min(1).max(MAX_BOOKING_PILGRIMS),
  childSide: z.enum(CHILD_SIDES).optional(),
  quoteId: uuid.optional(),
}

function stayRules(body: { bookingType: string, checkIn: string, checkOut: string, maleCount: number, femaleCount: number, childCount: number, totalCount: number }, ctx: z.RefinementCtx): void {
  addStayDateIssues(body, ctx)
  if (body.bookingType === 'GROUP' && body.maleCount + body.femaleCount + body.childCount !== body.totalCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['totalCount'], message: 'For a group, men + women + children must equal the total' })
  }
  if (body.bookingType === 'FAMILY' && (body.maleCount !== 0 || body.femaleCount !== 0 || body.childCount !== 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maleCount'], message: 'A family gives only the total' })
  }
}

/** The room options for a stay (v7 §9): agency portal, staff on an agency's behalf, public site. */
export const staySearchSchema = z.object(stayFields).strict().superRefine(stayRules)
export type StaySearchInput = z.infer<typeof staySearchSchema>

/** One room of the chosen option, as the search returned it. */
export const chosenRoomSchema = z.object({
  roomId: uuid,
  occupancy: z.enum(OCCUPANCIES),
  seats: z.number().int().min(1).max(30),
  extraBeds: z.number().int().min(0).max(5).default(0),
}).strict()

const holdFields = {
  ...stayFields,
  rooms: z.array(chosenRoomSchema).min(1).max(MAX_BOOKING_ROOMS),
  notes: safeText(1000).optional(),
}

/** Hold the chosen option (v7 §9.2 step 7, §10): the rooms are locked and checked again before anything is saved. */
export const holdRequestSchema = z.object(holdFields).strict().superRefine(stayRules)
export type HoldRequestInput = z.infer<typeof holdRequestSchema>

/** `POST /api/stays/search` (staff on an agency's behalf, v7 §6): the same search for the named agency. */
export const staffStaySearchSchema = z.object({ ...stayFields, agencyId: uuid }).strict().superRefine(stayRules)
export type StaffStaySearchInput = z.infer<typeof staffStaySearchSchema>

/** `POST /api/bookings` (staff on an agency's behalf). */
export const staffHoldRequestSchema = z.object({ ...holdFields, agencyId: uuid }).strict().superRefine(stayRules)
export type StaffHoldRequestInput = z.infer<typeof staffHoldRequestSchema>

/** `GET /api/bookings` (staff) and `GET /api/agency/bookings` (agency; `agencyId` ignored there). Newest first. */
export const listBookingsQuerySchema = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
  hotelId: uuid.optional(),
  agencyId: uuid.optional(),
  /** The start of a booking number (`B-2027-00`). */
  q: z.string().trim().min(1).max(30).optional(),
}).merge(pagination({ maxPageSize: 100 }))
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>
