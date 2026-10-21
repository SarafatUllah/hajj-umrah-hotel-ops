import { createError, defineEventHandler, getRequestHeader, getRequestHost, getRequestIP, getRequestProtocol, proxyRequest } from 'h3'
import { forwardablePath, visitorAddress } from '../utils/apiProxy'

/**
 * The app's `/api/**`, forwarded to the API (D-P2-52): only the prefixes this app uses (`apiProxy.allow`; anything
 * else is 404 here), the session cookie first-party, and the visitor's address set here — never taken from the
 * visitor — so the API's per-address limits see each visitor (the API trusts the one proxy in front of it).
 */
export default defineEventHandler(async (event) => {
  const { apiProxy } = useRuntimeConfig(event)
  const path = forwardablePath(event.path, apiProxy.allow)
  if (!path) throw createError({ statusCode: 404, statusMessage: 'Not found', data: { code: 'NOT_FOUND' } })
  const trustProxy = apiProxy.trustProxy === true
  return proxyRequest(event, `${apiProxy.target}${path}`, {
    headers: {
      'x-forwarded-for': visitorAddress(getRequestHeader(event, 'x-forwarded-for'), getRequestIP(event), trustProxy),
      'x-forwarded-host': getRequestHost(event, { xForwardedHost: trustProxy }),
      'x-forwarded-proto': getRequestProtocol(event, { xForwardedProto: trustProxy }),
    },
  })
})
