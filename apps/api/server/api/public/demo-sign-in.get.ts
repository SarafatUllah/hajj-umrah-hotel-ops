import { setResponseHeader } from 'h3'
import { defineApiHandler } from '../../utils/apiHandler'
import { NotFoundError } from '../../errors/domainError'
import { getDemoSignIn } from '../../services/demoSignInService'
import { useDb } from '../../utils/db'

/**
 * Public, unauthenticated, runtime-gated demo sign-in metadata (S14 / D9). When the gate is closed — or the
 * demo organization does not exist — it fails with EXACTLY the error the catch-all route (`server/api/[...].ts`)
 * produces for an unknown path (404 `NOT_FOUND` "Not found"), never 403 or a "disabled" message, so its
 * existence cannot be probed. It never mints a session.
 */
export default defineApiHandler({
  handler: async ({ event }) => {
    const payload = await getDemoSignIn(useDb())
    if (!payload) throw new NotFoundError('NOT_FOUND', 'Not found')
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return payload
  },
})
