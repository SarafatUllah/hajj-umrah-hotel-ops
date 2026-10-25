import { createError, defineEventHandler, getRequestHeader, getRequestHost } from 'h3'
import { isRefusedCrossSiteRequest } from '../security/originCheck'
import { getEnv } from '../utils/env'

/** Refuses cross-site unsafe API requests (see server/security/originCheck.ts) with 403 `CSRF_ORIGIN_MISMATCH`. */
export default defineEventHandler((event) => {
  const env = getEnv()
  const refused = isRefusedCrossSiteRequest({
    method: event.method,
    path: event.path,
    origin: getRequestHeader(event, 'origin'),
    secFetchSite: getRequestHeader(event, 'sec-fetch-site'),
    host: getRequestHost(event, { xForwardedHost: env.TRUST_PROXY }),
    allowedOrigins: env.ALLOWED_ORIGINS,
  })
  if (refused) {
    throw createError({ statusCode: 403, statusMessage: 'Cross-site request refused', data: { code: 'CSRF_ORIGIN_MISMATCH' } })
  }
})
