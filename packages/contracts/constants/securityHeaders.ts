/**
 * The headers every response carries, the API's and the frontends' alike (step 17): never shown in another site's
 * frame (clickjacking on confirm, cancel or approve), no content-type sniffing, HTTPS only once seen over HTTPS, the
 * referrer cut to the origin elsewhere, and only this site's own camera (the desk's receipt scanner).
 */
export const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
} as const
