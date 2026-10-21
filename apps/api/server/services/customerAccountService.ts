import { rethrowDbError } from '../errors/dbErrors'
import { ForbiddenError } from '../errors/domainError'
import type { CustomerContext } from '../security/customerContext'
import { closeCustomerRecord } from './accounts'
import { releaseCustomerBookings } from './booking'

/** How recent the code a closure is confirmed with must be (D-P2-27b: a fresh code before anything irreversible). */
const STEP_UP_WINDOW_MS = 10 * 60_000

/**
 * Step 15b: the customer closes their account. Irreversible, so it needs a code verified in the last few minutes
 * (403 `STEP_UP_REQUIRED`: sign in again with a new code). One transaction: the booking module withdraws the open
 * requests under the customer's request lock — refused while a confirmed stay is not over (409 `ACTIVE_BOOKINGS`: the
 * hotel cancels it) — then the accounts module anonymizes the account and ends every session. Past bookings keep
 * naming the closed account; their pilgrims' details go with the retention sweep (D-P2-45).
 */
export async function closeCustomerAccount(ctx: CustomerContext): Promise<{ withdrawn: string[] }> {
  const now = ctx.now()
  if (!ctx.signedInAt || now.getTime() - ctx.signedInAt.getTime() > STEP_UP_WINDOW_MS) {
    throw new ForbiddenError('STEP_UP_REQUIRED', 'Confirm with a new code before closing the account')
  }
  return ctx.db.transaction(async (tx) => {
    const withdrawn = await releaseCustomerBookings(tx, ctx.scope, ctx.scope.customerId, now)
    await closeCustomerRecord(tx, ctx.scope, ctx.scope.customerId, now)
    return { withdrawn }
  }).catch(rethrowDbError)
}
