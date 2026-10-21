import { z } from 'zod'
import { AGENCY_STATUSES } from '../constants/accounts'
import { e164Phone, newPassword, pagination, safeText } from './common'

const agencyProfile = {
  name: safeText(200).refine(v => v.length > 0, 'Required'),
  licenseNo: safeText(100).refine(v => v.length > 0, 'Required'),
  contactName: safeText(200).refine(v => v.length > 0, 'Required'),
  phone: e164Phone,
  email: z.string().trim().email().max(254),
  whatsappNumber: e164Phone.optional(),
  address: safeText(500).optional(),
}

const agencyUser = {
  fullName: safeText(200).refine(v => v.length > 0, 'Required'),
  email: z.string().trim().email().max(254),
  password: newPassword,
}

/** `POST /api/agency/register` (agency portal, public): the agency and its first user; starts PENDING. */
export const agencyRegistrationSchema = z.object({
  organizationSlug: z.string().min(1).max(100),
  agency: z.object(agencyProfile).strict(),
  user: z.object(agencyUser).strict(),
}).strict()
export type AgencyRegistrationInput = z.infer<typeof agencyRegistrationSchema>

/** `POST /api/agencies` (staff): an agency the staff verified offline, approved at once, with its first user. */
export const createAgencySchema = z.object({
  agency: z.object(agencyProfile).strict(),
  user: z.object(agencyUser).strict(),
}).strict()
export type CreateAgencyInput = z.infer<typeof createAgencySchema>

/** `POST /api/agencies/:agencyId/status` (staff): approve, suspend or reject, with a reason. */
export const agencyStatusChangeSchema = z.object({
  status: z.enum(['APPROVED', 'SUSPENDED', 'REJECTED']),
  reason: safeText(500).refine(v => v.length >= 3, 'Give a reason'),
}).strict()
export type AgencyStatusChangeInput = z.infer<typeof agencyStatusChangeSchema>

/** `POST /api/agencies/:agencyId/users` (staff). */
export const createAgencyUserSchema = z.object(agencyUser).strict()
export type CreateAgencyUserInput = z.infer<typeof createAgencyUserSchema>

/** `PATCH /api/agencies/:agencyId/users/:userId` (staff). */
export const updateAgencyUserSchema = z.object({ isActive: z.boolean() }).strict()
export type UpdateAgencyUserInput = z.infer<typeof updateAgencyUserSchema>

/** `POST /api/agencies/:agencyId/users/:userId/password` (staff): a new password for a user who lost theirs. */
export const agencyUserPasswordSchema = z.object({ password: newPassword }).strict()
export type AgencyUserPasswordInput = z.infer<typeof agencyUserPasswordSchema>

/** `POST /api/agency/auth/password` (agency portal): the user's own new password, proven by the current one. */
export const agencyPasswordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword,
}).strict().refine(body => body.newPassword !== body.currentPassword, { path: ['newPassword'], message: 'Choose a different password' })
export type AgencyPasswordChangeInput = z.infer<typeof agencyPasswordChangeSchema>

/** `GET /api/agencies` (staff). */
export const listAgenciesQuerySchema = z.object({
  status: z.enum(AGENCY_STATUSES).optional(),
  q: safeText(100).optional(),
}).merge(pagination({ maxPageSize: 100 }))
export type ListAgenciesQuery = z.infer<typeof listAgenciesQuerySchema>

/** `POST /api/agency/auth/login` (agency portal). */
export const agencyLoginSchema = z.object({
  organizationSlug: z.string().min(1).max(100),
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
}).strict()
export type AgencyLoginInput = z.infer<typeof agencyLoginSchema>
