import { createError, defineEventHandler, getRequestHeader, getRequestHost, getRequestIP, getRequestProtocol, proxyRequest } from 'h3'
import { bodyRefusal, forwardablePath, forwardedHeaders, PROXY_TIMEOUT_MS, proxyTargetUrl, visitorAddress } from '../utils/apiProxy'

/**
 * The app's `/api/**`, forwarded to the API (D-P2-52): only the prefixes this app uses (`apiProxy.allow`; anything
 * else is 404 here), the session cookie first-party, and the visitor's address set here — never taken from the
 * visitor — so the API's per-address limits see each visitor (the API trusts the one proxy in front of it).
 */
export default defineEventHandler(async (event) => {
  const { apiProxy } = useRuntimeConfig(event)
  const path = forwardablePath(event.path, apiProxy.allow)
  if (!path) throw createError({ statusCode: 404, statusMessage: 'Not found', data: { code: 'NOT_FOUND' } })
  // proxyRequest reads the whole body before it forwards it: its size is bounded first.
  const refused = bodyRefusal(getRequestHeader(event, 'content-length'), getRequestHeader(event, 'transfer-encoding'))
  if (refused) throw createError({ statusCode: refused.statusCode, statusMessage: 'Request refused', data: { code: refused.code } })
  const trustProxy = apiProxy.trustProxy === true
  return proxyRequest(event, proxyTargetUrl(apiProxy.target, path), {
    // The API's time starts once the visitor's body is in (proxyRequest reads it first): a slow upload is no timeout.
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) }),
    headers: forwardedHeaders(
      visitorAddress(getRequestHeader(event, 'x-forwarded-for'), getRequestIP(event), trustProxy),
      getRequestHost(event, { xForwardedHost: trustProxy }),
      getRequestProtocol(event, { xForwardedProto: trustProxy }),
    ),
  })
})
