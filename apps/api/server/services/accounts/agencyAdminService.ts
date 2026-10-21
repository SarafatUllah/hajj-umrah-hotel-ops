import type { AgencyStatus } from '@hajj/contracts/constants/accounts'
import type { AgencyStatusChangeInput, AgencyUserPasswordInput, CreateAgencyInput, CreateAgencyUserInput, ListAgenciesQuery, UpdateAgencyUserInput } from '@hajj/contracts/schemas/agency'
import { normalizeEmail } from '@hajj/contracts/utils/email'
import { rethrowDbError } from '../../errors/dbErrors'
import { ConflictError, NotFoundError } from '../../errors/domainError'
import { accountsRepos, tenantRepos } from '../../repositories'
import type { AgencyRow } from '../../repositories/accounts'
import type { AuthContext } from '../../security/authContext'
import { requireAllHotels, requireOrgPermission } from '../../security/authorize'
import { hashPassword } from '../../utils/password'
import { canChangeAgencyStatus, normalizeLicenseNo } from '../../domain/accounts/agencyRules'
import { recordAudit } from '../audit'
import type { AgencyDetail, AgencyDto, AgencyListPage, AgencyUserDto } from '@hajj/contracts/types/agency'
import { toAgencyDto, toAgencyUserDto } from './agencyDto'

export type { AgencyDetail, AgencyListPage }

/** The database handle a repository accepts (a service may not import db/client itself). */
type Db = Parameters<typeof accountsRepos>[0]

/** Agencies serve every hotel of the organization: changing them needs `agency.manage` AND access to every hotel. */
function requireAgencyManager(ctx: AuthContext): void {
  requireOrgPermission(ctx, 'agency.manage')
  requireAllHotels(ctx)
}

async function loadAgency(ctx: AuthContext, agencyId: string, forUpdate = false, db: Db = ctx.db): Promise<AgencyRow> {
  const row = await accountsRepos(db, ctx.scope).agencies.findById(agencyId, { forUpdate })
  if (!row) throw new NotFoundError('AGENCY_NOT_FOUND')
  return row
}

export async function listAgencies(ctx: AuthContext, query: ListAgenciesQuery): Promise<AgencyListPage> {
  requireOrgPermission(ctx, 'agency.view')
  const { rows, total } = await accountsRepos(ctx.db, ctx.scope).agencies.list(query)
  return { items: rows.map(toAgencyDto), total, page: query.page, pageSize: query.pageSize }
}

export async function getAgency(ctx: AuthContext, agencyId: string): Promise<AgencyDetail> {
  requireOrgPermission(ctx, 'agency.view')
  const row = await loadAgency(ctx, agencyId)
  const users = await accountsRepos(ctx.db, ctx.scope).agencyUsers.listByAgency(row.id)
  return { ...toAgencyDto(row), users: users.map(toAgencyUserDto) }
}

/** Staff create an agency they verified offline: APPROVED at once, with its first user. Audited. */
export async function createAgency(ctx: AuthContext, input: CreateAgencyInput): Promise<AgencyDetail> {
  requireAgencyManager(ctx)
  const passwordHash = await hashPassword(input.user.password)
  const now = ctx.now()
  return ctx.db.transaction(async (tx) => {
    const repos = accountsRepos(tx, ctx.scope)
    const row = await repos.agencies.insert({ ...input.agency, licenseNo: normalizeLicenseNo(input.agency.licenseNo), email: normalizeEmail(input.agency.email), status: 'APPROVED', approvedAt: now, approvedBy: ctx.identity.userId })
    const user = await repos.agencyUsers.insert({ agencyId: row.id, email: normalizeEmail(input.user.email), fullName: input.user.fullName, passwordHash })
    const audit = tenantRepos(tx, ctx.scope).audit
    await recordAudit(audit, ctx.identity.userId, { entityType: 'agency', entityId: row.id, action: 'AGENCY_CREATED', after: toAgencyDto(row) })
    await recordAudit(audit, ctx.identity.userId, { entityType: 'agency_user', entityId: user.id, action: 'AGENCY_USER_CREATED', after: toAgencyUserDto(user) })
    return { ...toAgencyDto(row), users: [toAgencyUserDto(user)] }
  }).catch(rethrowDbError)
}

/** Approve, suspend or reject (v7 §15), with a reason; the agency row is locked so decisions serialize. Audited. */
export async function changeAgencyStatus(ctx: AuthContext, agencyId: string, input: AgencyStatusChangeInput): Promise<AgencyDto> {
  requireAgencyManager(ctx)
  return ctx.db.transaction(async (tx) => {
    const current = await loadAgency(ctx, agencyId, true, tx)
    if (!canChangeAgencyStatus(current.status as AgencyStatus, input.status)) {
      throw new ConflictError('AGENCY_STATUS_TRANSITION', `An agency that is ${current.status} cannot become ${input.status}`)
    }
    const updated = (await accountsRepos(tx, ctx.scope).agencies.setStatus(current.id, { status: input.status, reason: input.reason, at: ctx.now(), by: ctx.identity.userId }))!
    await recordAudit(tenantRepos(tx, ctx.scope).audit, ctx.identity.userId, { entityType: 'agency', entityId: current.id, action: 'AGENCY_STATUS_CHANGED', before: { status: current.status }, after: { status: updated.status }, reason: input.reason })
    return toAgencyDto(updated)
  })
}

export async function addAgencyUser(ctx: AuthContext, agencyId: string, input: CreateAgencyUserInput): Promise<AgencyUserDto> {
  requireAgencyManager(ctx)
  const passwordHash = await hashPassword(input.password)
  return ctx.db.transaction(async (tx) => {
    const current = await loadAgency(ctx, agencyId, false, tx)
    const user = await accountsRepos(tx, ctx.scope).agencyUsers.insert({ agencyId: current.id, email: normalizeEmail(input.email), fullName: input.fullName, passwordHash })
    await recordAudit(tenantRepos(tx, ctx.scope).audit, ctx.identity.userId, { entityType: 'agency_user', entityId: user.id, action: 'AGENCY_USER_CREATED', after: toAgencyUserDto(user) })
    return toAgencyUserDto(user)
  }).catch(rethrowDbError)
}

/**
 * A new password for an agency user who lost theirs (D-P2-25b; `agency.manage` with every hotel): staff give it to
 * the user themselves, off the system. Every session of the user ends. Audited without the password.
 */
export async function resetAgencyUserPassword(ctx: AuthContext, agencyId: string, userId: string, input: AgencyUserPasswordInput): Promise<AgencyUserDto> {
  requireAgencyManager(ctx)
  const passwordHash = await hashPassword(input.password)
  return ctx.db.transaction(async (tx) => {
    const repos = accountsRepos(tx, ctx.scope)
    const user = await repos.agencyUsers.findById(userId)
    if (!user || user.agencyId !== agencyId) throw new NotFoundError('AGENCY_USER_NOT_FOUND')
    const updated = (await repos.agencyUsers.setPassword(userId, agencyId, passwordHash, ctx.now()))!
    await recordAudit(tenantRepos(tx, ctx.scope).audit, ctx.identity.userId, { entityType: 'agency_user', entityId: userId, action: 'AGENCY_USER_PASSWORD_RESET' })
    return toAgencyUserDto(updated)
  })
}

/** Activates or deactivates an agency user; deactivation ends every session of that user. Audited. */
export async function updateAgencyUser(ctx: AuthContext, agencyId: string, userId: string, input: UpdateAgencyUserInput): Promise<AgencyUserDto> {
  requireAgencyManager(ctx)
  return ctx.db.transaction(async (tx) => {
    const repos = accountsRepos(tx, ctx.scope)
    const before = await repos.agencyUsers.findById(userId)
    if (!before || before.agencyId !== agencyId) throw new NotFoundError('AGENCY_USER_NOT_FOUND')
    const updated = (await repos.agencyUsers.setActive(userId, agencyId, input.isActive, ctx.now()))!
    await recordAudit(tenantRepos(tx, ctx.scope).audit, ctx.identity.userId, { entityType: 'agency_user', entityId: userId, action: 'AGENCY_USER_UPDATED', before: { isActive: before.isActive }, after: { isActive: updated.isActive } })
    return toAgencyUserDto(updated)
  })
}
