import { defineEventHandler, setResponseStatus } from 'h3'
import { pingDb } from '../utils/db'

/**
 * Platform health check (ARCHITECTURE §20). Deliberately outside `defineApiHandler`: a health probe
 * is not a `DomainError`-shaped endpoint — a degraded DB still returns a real (200/503) status with
 * its own small body, never `{ statusCode, statusMessage, data.code }`. Job-queue liveness (§20) is
 * not checked here: a failed job-runtime start is logged and tried again (server/plugins/jobs.ts).
 */
export default defineEventHandler(async (event) => {
  try {
    await pingDb()
    return { status: 'ok', db: 'ok' }
  }
  catch {
    setResponseStatus(event, 503)
    return { status: 'degraded', db: 'down' }
  }
})
