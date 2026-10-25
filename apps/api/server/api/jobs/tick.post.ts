import { getRequestHeader, setResponseHeader } from 'h3'
import { NotFoundError, UnauthenticatedError } from '../../errors/domainError'
import { JOBS } from '../../jobs'
import { runJobPass } from '../../jobs/pass'
import { isAuthorizedTick } from '../../jobs/tickAuth'
import { defineApiHandler } from '../../utils/apiHandler'
import { useDb } from '../../utils/db'
import { getEnv } from '../../utils/env'

/** A pass stops this long after it started (well within a serverless function's time limit); unfinished work waits for the next tick. */
const TICK_BUDGET_MS = 20_000

/**
 * The background jobs of a host without an always-on worker (D-P2-67, docs/DEPLOY_VERCEL.md): a scheduler calls this
 * every few minutes with `Authorization: Bearer <JOBS_TICK_SECRET>`, and one job pass runs every due schedule and
 * queued job. Without JOBS_TICK_SECRET it answers exactly like an unknown route, so its existence cannot be probed.
 */
export default defineApiHandler({
  handler: async ({ event }) => {
    const env = getEnv()
    if (!env.JOBS_TICK_SECRET) throw new NotFoundError('NOT_FOUND', 'Not found')
    if (!isAuthorizedTick(getRequestHeader(event, 'authorization'), env.JOBS_TICK_SECRET)) throw new UnauthenticatedError('UNAUTHENTICATED', 'Not authorized')
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return runJobPass({ connectionString: env.DATABASE_URL, db: useDb(), jobs: JOBS, poolMax: env.JOBS_POOL_MAX, budgetMs: TICK_BUDGET_MS })
  },
})
