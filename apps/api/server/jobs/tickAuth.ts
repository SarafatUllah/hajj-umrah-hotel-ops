import { createHash, timingSafeEqual } from 'node:crypto'

const BEARER = 'Bearer '

/** Fixed-length digests, so the comparison takes the same time whatever the token's length or content. */
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()

/** Whether an `Authorization` header carries exactly `secret` as its bearer token (constant-time comparison). */
export function isAuthorizedTick(authorization: string | undefined, secret: string): boolean {
  if (!authorization?.startsWith(BEARER)) return false
  return timingSafeEqual(digest(authorization.slice(BEARER.length)), digest(secret))
}
