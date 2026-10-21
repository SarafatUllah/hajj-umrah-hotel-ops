import type { AgencyLoginInput, AgencyPasswordChangeInput, AgencyRegistrationInput } from '@hajj/contracts/schemas/agency'
import type { AgencyMe } from '@hajj/contracts/types/agency'
import { normalizeEmail } from '@hajj/contracts/utils/email'
import { translateDbError } from '../../errors/dbErrors'
import { UnauthenticatedError, ValidationError } from '../../errors/domainError'
import { accountsRepos, tenantRepos } from '../../repositories'
import type { AgencyContext } from '../../security/agencyContext'
import { beginLoginAttempt, clearLoginAttempt, type LoginRequest } from '../../security/loginThrottle'
import { consumeRateLimit, RATE_LIMITS } from '../../security/rateLimit'
import { resolveTenantBySlug } from '../../security/tenantResolver'
import { useDb } from '../../utils/db'
import { hashPassword, TIMING_SAFETY_DUMMY_HASH, verifyPassword } from '../../utils/password'
import { normalizeLicenseNo } from '../../domain/accounts/agencyRules'
import { recordAudit } from '../audit'
import { toAgencyDto, toAgencyUserDto } from './agencyDto'

/** What an agency-portal session carries (identity only; everything else is resolved per request). */
export interface AgencySessionUser {
  id: string
  organizationId: string
  agencyId: string
  email: string
  fullName: string
  sessionVersion: number
}

export type { AgencyMe }

/**
 * Public self-registration on the agency portal (v7 §15): the agency starts PENDING and gets no agency price,
 * quote or booking until staff approve it after checking the licence. The answer never says whether the licence
 * number or e-mail is already known (no enumeration): a duplicate is silently not created, after the same
 * Argon2 work, and staff see only real new registrations — plus, on the known agency's audit, that a registration
 * repeated its licence or e-mail and from where (someone may be using another agency's licence: staff check the
 * licence and its contact with the ministry, never only what was typed). Rate limited per client address and per
 * organization; the audit row records the client address. An unknown organization answers like a validation
 * error on the slug (one operator, so this reveals nothing).
 */
export async function registerAgency(input: AgencyRegistrationInput, request: LoginRequest): Promise<{ received: true }> {
  const db = useDb()
  await consumeRateLimit(db, RATE_LIMITS.agencyRegistrationPerIp, request.clientIp, request.now)
  const tenant = await resolveTenantBySlug(db, input.organizationSlug)
  if (!tenant) throw new ValidationError('INVALID_REFERENCE', 'Unknown organization')
  await consumeRateLimit(db, RATE_LIMITS.agencyRegistrationPerOrganization, tenant.scope.organizationId, request.now)
  const passwordHash = await hashPassword(input.user.password)
  const licenseNo = normalizeLicenseNo(input.agency.licenseNo)
  const email = normalizeEmail(input.user.email)

  await db.transaction(async (tx) => {
    const repos = accountsRepos(tx, tenant.scope)
    const audit = tenantRepos(tx, tenant.scope).audit
    const byLicence = await repos.agencies.findByLicenseNo(licenseNo)
    const knownAgencyId = byLicence?.id ?? (await repos.agencyUsers.findByEmail(email))?.agencyId
    if (knownAgencyId) {
      await recordAudit(audit, null, { entityType: 'agency', entityId: knownAgencyId, action: 'AGENCY_REGISTRATION_REPEATED', after: { matched: byLicence ? 'licence' : 'email', clientIp: request.clientIp } })
      return
    }
    const agencyRow = await repos.agencies.insert({ ...input.agency, licenseNo, email: normalizeEmail(input.agency.email), status: 'PENDING' })
    const user = await repos.agencyUsers.insert({ agencyId: agencyRow.id, email, fullName: input.user.fullName, passwordHash })
    await recordAudit(audit, null, { entityType: 'agency', entityId: agencyRow.id, action: 'AGENCY_REGISTERED', after: { ...toAgencyDto(agencyRow), clientIp: request.clientIp } })
    await recordAudit(audit, null, { entityType: 'agency_user', entityId: user.id, action: 'AGENCY_USER_CREATED', after: toAgencyUserDto(user) })
  }).catch((error: unknown) => {
    // A concurrent registration of the same licence or e-mail: the same silent answer.
    if (translateDbError(error)?.code === 'ALREADY_EXISTS') return
    throw error
  })
  return { received: true }
}

/**
 * Agency-portal sign-in: the same throttling as staff (`beginLoginAttempt`, its own counters), one Argon2 verify
 * whether or not the organization and user exist, and the same answer for every failure. A pending, suspended
 * or rejected agency may sign in (to see its status); business routes refuse it (`requireApprovedAgency`).
 */
export async function loginAgencyUser(input: AgencyLoginInput, request: LoginRequest): Promise<AgencySessionUser | null> {
  const db = useDb()
  const attempt = await beginLoginAttempt(db, 'agency', input.organizationSlug, input.email, request)
  const tenant = await resolveTenantBySlug(db, input.organizationSlug)
  const repos = tenant ? accountsRepos(db, tenant.scope) : null
  const user = repos ? await repos.agencyUsers.findActiveByEmail(normalizeEmail(input.email)) : null
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? TIMING_SAFETY_DUMMY_HASH)
  if (!repos || !user || !passwordOk) return null

  await clearLoginAttempt(db, attempt)
  await repos.agencyUsers.recordLogin(user.id, request.now)
  return { id: user.id, organizationId: user.organizationId, agencyId: user.agencyId, email: user.email, fullName: user.fullName, sessionVersion: user.sessionVersion }
}

/** The portal's view of the signed-in user and their agency (allowed whatever the agency's status). */
/**
 * An agency user changes their own password (D-P2-25b), whatever the agency's status: the current one proves it is
 * them (wrong: 422 `CURRENT_PASSWORD_WRONG`, at most 5 tries per user in 15 minutes), then every session of theirs
 * ends — the route renews the caller's own with the new session version. Audited without either password.
 */
export async function changeAgencyPassword(ctx: AgencyContext, input: AgencyPasswordChangeInput): Promise<AgencySessionUser> {
  const userId = ctx.identity.agencyUserId
  await consumeRateLimit(ctx.db, RATE_LIMITS.passwordChangePerAgencyUser, userId, ctx.now())
  const user = await accountsRepos(ctx.db, ctx.scope).agencyUsers.findById(userId)
  if (!user || !await verifyPassword(input.currentPassword, user.passwordHash)) throw new ValidationError('CURRENT_PASSWORD_WRONG', 'The current password is not right')
  const passwordHash = await hashPassword(input.newPassword)
  return ctx.db.transaction(async (tx) => {
    const updated = await accountsRepos(tx, ctx.scope).agencyUsers.setPassword(user.id, user.agencyId, passwordHash, ctx.now())
    if (!updated) throw new UnauthenticatedError('SESSION_INVALID', 'Your session has ended. Sign in again.')
    await recordAudit(tenantRepos(tx, ctx.scope).audit, null, { entityType: 'agency_user', entityId: user.id, action: 'AGENCY_USER_PASSWORD_CHANGED' })
    return { id: updated.id, organizationId: updated.organizationId, agencyId: updated.agencyId, email: updated.email, fullName: updated.fullName, sessionVersion: updated.sessionVersion }
  })
}

export function getAgencyMe(ctx: AgencyContext): AgencyMe {
  return {
    user: { id: ctx.identity.agencyUserId, agencyId: ctx.identity.agencyId, email: ctx.identity.email, fullName: ctx.identity.fullName },
    agency: { id: ctx.agency.id, name: ctx.agency.name, status: ctx.agency.status },
  }
}
