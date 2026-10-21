import { defineApiHandler } from '../utils/apiHandler'
import { NotFoundError } from '../errors/domainError'

/**
 * Catch-all for any request under /api/** that no other route matched (PF-16). Without this, Nitro's
 * own default 404 never passes through `defineApiHandler`'s error wrapper, so it lacks `data.code` —
 * breaking the "every non-2xx response has a standard error shape" invariant (Task 8 proof 10).
 */
export default defineApiHandler({
  handler: async () => {
    throw new NotFoundError('NOT_FOUND', 'Not found')
  },
})
