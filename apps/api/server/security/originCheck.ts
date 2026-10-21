/**
 * Cross-site request refusal for the cookie-authenticated API (design v7 §21: CSRF). SameSite=Lax session
 * cookies are the first line; this check is the second: an unsafe request under `/api/` is refused when
 * its `Origin` is neither the API's own host nor one of `ALLOWED_ORIGINS` (the separate frontends), or
 * when it carries no `Origin` but the browser marked it `Sec-Fetch-Site: cross-site`. A request without
 * either header (curl, server-to-server) is not a browser request and passes.
 */
export interface OriginCheckRequest {
  method: string
  path: string
  origin: string | undefined
  secFetchSite: string | undefined
  /** The request's own host (`Host`, or `X-Forwarded-Host` behind a trusted proxy). */
  host: string
  allowedOrigins: readonly string[]
}

const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function isSameHost(origin: string, host: string): boolean {
  try {
    const url = new URL(origin)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.host === host.toLowerCase()
  }
  catch {
    // `Origin: null` (sandboxed frames, some redirects) and anything else unparsable is never ours.
    return false
  }
}

export function isRefusedCrossSiteRequest(request: OriginCheckRequest): boolean {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return false
  if (!request.path.startsWith('/api/')) return false
  if (request.origin !== undefined) {
    return !(request.allowedOrigins.includes(request.origin) || isSameHost(request.origin, request.host))
  }
  return request.secFetchSite === 'cross-site'
}
