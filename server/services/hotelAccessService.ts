import type { HotelAccessBody } from '../../shared/schemas/hotelAccess'
import { recordAudit } from './audit'
import { ForbiddenError, NotFoundError, ValidationError } from '../errors/domainError'
import { tenantRepos } from '../repositories'
import type { AuthContext } from '../security/authContext'
import { requireOrgPermission } from '../security/authorize'

export interface HotelAccessState {
  allHotels: boolean
  hotelIds: string[]
}

/** Rule 1 (403) + rule 2 (404, indistinguishable from nonexistent) apply to both read and write. */
async function loadTargetOrThrow(ctx: AuthContext, userId: string) {
  const target = await tenantRepos(ctx.db, ctx.scope).users.findById(userId)
  if (!target) throw new NotFoundError('USER_NOT_FOUND')
  return target
}

export async function getUserHotelAccess(ctx: AuthContext, userId: string): Promise<HotelAccessState> {
  requireOrgPermission(ctx, 'user.manage') // rule 1

  const target = await loadTargetOrThrow(ctx, userId) // rule 2
  const hotelIds = await tenantRepos(ctx.db, ctx.scope).userHotelAccess.hotelIdsForUser(userId)

  return { allHotels: target.allHotels, hotelIds }
}

export async function setUserHotelAccess(ctx: AuthContext, userId: string, input: HotelAccessBody): Promise<HotelAccessState> {
  requireOrgPermission(ctx, 'user.manage') // rule 1

  // Rule 3: ambiguous input is rejected before any DB work at all (cheaper than a round trip, and
  // this check needs neither the target row nor the hotel rows to evaluate).
  if (input.allHotels && input.hotelIds.length > 0) {
    throw new ValidationError('AMBIGUOUS_HOTEL_ACCESS', 'allHotels and hotelIds are mutually exclusive')
  }

  const repos = tenantRepos(ctx.db, ctx.scope)

  await loadTargetOrThrow(ctx, userId) // rule 2 (existence only — a nonexistent target has nothing to
  // race over, so this cheap pre-transaction check is fine as-is; the target's mutable state is
  // re-read fresh, under a row lock, inside the transaction below)

  // Rule 4: every hotelId in the body must belong to the caller's organization, or this is a
  // validation failure (422 INVALID_REFERENCE) — never a 404 (bodies never leak existence the way
  // URL ids do).
  if (input.hotelIds.length > 0) {
    const found = await repos.hotels.listByIds(input.hotelIds)
    if (found.length !== new Set(input.hotelIds).size) {
      throw new ValidationError('INVALID_REFERENCE', 'One or more hotel ids are not valid for this organization')
    }
  }

  // Rule 5 (first three conditions): a caller without allHotels is restricted to hotels they
  // themselves hold, can never grant allHotels, and can never touch their own access row. None of
  // this depends on the target's live DB state, so it can be checked now, before the transaction.
  // The fourth condition — can never modify an allHotels target — depends on a fresh read of the
  // target's mutable state and is checked below, atomically with that read (see the transaction).
  // Rule 6: a caller with allHotels is unrestricted by any of this.
  if (!ctx.authz.allHotels) {
    if (input.hotelIds.some(hotelId => !ctx.authz.hotelIds.has(hotelId))) throw new ForbiddenError('ESCALATION_DENIED')
    if (input.allHotels) throw new ForbiddenError('ESCALATION_DENIED')
    if (userId === ctx.identity.userId) throw new ForbiddenError('ESCALATION_DENIED')
  }

  const after: HotelAccessState = { allHotels: input.allHotels, hotelIds: [...input.hotelIds] }
  let before!: HotelAccessState

  // Rule 7: replace (delete + insert) + the allHotels flag + the audit row all run in one
  // transaction — any failure rolls back the entire change, nothing partially applies.
  //
  // The target's row is locked here (SELECT ... FOR UPDATE) so the fresh read of its current
  // allHotels (rule 5's fourth condition) and its current hotelIds (the audit `before` snapshot)
  // happen atomically with the subsequent write: a concurrent setUserHotelAccess call against the
  // SAME target serializes behind this transaction instead of racing it on stale reads (TOCTOU fix).
  await ctx.db.transaction(async (tx) => {
    const txRepos = tenantRepos(tx, ctx.scope)

    const lockedTarget = await txRepos.users.findByIdForUpdate(userId)
    if (!lockedTarget) throw new NotFoundError('USER_NOT_FOUND') // target deleted concurrently

    // Rule 5 (fourth condition), evaluated against the just-locked, up-to-date read.
    if (!ctx.authz.allHotels && lockedTarget.allHotels) throw new ForbiddenError('ESCALATION_DENIED')

    before = { allHotels: lockedTarget.allHotels, hotelIds: await txRepos.userHotelAccess.hotelIdsForUser(userId) }

    await txRepos.userHotelAccess.replaceForUser(userId, input.hotelIds, ctx.identity.userId)
    await txRepos.users.setAllHotels(userId, input.allHotels)
    // Rule 8: exactly one USER_HOTEL_ACCESS_CHANGED audit entry, org-level (hotel_id null), full
    // before/after state (not a diff).
    await recordAudit(txRepos.audit, ctx.identity.userId, {
      hotelId: null,
      entityType: 'user',
      entityId: userId,
      action: 'USER_HOTEL_ACCESS_CHANGED',
      before,
      after,
    })
  })

  return after // rule 9
}
