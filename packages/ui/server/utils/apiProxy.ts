import { MAX_UPLOAD_BYTES } from '@hajj/contracts/constants/documents'
import { VISITOR_ADDRESS_HEADER } from '@hajj/contracts/constants/proxy'

/**
 * The path a frontend may forward to the API, or null: only under its allowed prefixes (`/api/customer/` …; one
 * without a trailing slash is a whole resource — itself, below it or its query, never a longer name), and never a
 * path that could step out of them once normalized (`..`, encoded dots, backslashes, control characters).
 */
export function forwardablePath(path: string, allow: readonly string[]): string | null {
  if (/\.\.|%2e|%5c|\\/i.test(path) || hasControlCharacter(path)) return null
  return allow.some(prefix => isUnder(path, prefix)) ? path : null
}

const isUnder = (path: string, prefix: string): boolean => (prefix.endsWith('/')
  ? path.startsWith(prefix)
  : path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`))

/**
 * The API URL a forwarded path goes to: `target` is the API's base (`NUXT_API_PROXY_TARGET`) — an origin, or a base URL
 * the host generates (a Vercel service binding), possibly ending in `/`; `path` always starts with `/api/`.
 */
export function proxyTargetUrl(target: string, path: string): string {
  return `${target.replace(/\/+$/, '')}${path}`
}

/** Tabs, newlines and the other C0 controls: never part of a path the app builds. */
const FIRST_PRINTABLE = 0x20
export const hasControlCharacter = (text: string): boolean => [...text].some(character => character.charCodeAt(0) < FIRST_PRINTABLE)

/** How long the API may take before the visitor gets a 502 instead of a request hanging (the slowest, a demo reset, takes seconds). */
export const PROXY_TIMEOUT_MS = 60_000

/** The largest body the proxy forwards (h3 reads it whole before it sends it on): an upload at its limit, with its form's framing. */
export const MAX_PROXIED_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024

/**
 * Why a request body is refused before a byte of it is read, or null: a declared length over the largest legitimate
 * body is 413 `BODY_TOO_LARGE`; a chunked body without a declared length is 411 `LENGTH_REQUIRED` (it has no bound).
 */
export function bodyRefusal(contentLength: string | undefined, transferEncoding: string | undefined): { statusCode: 411 | 413, code: string } | null {
  if (contentLength === undefined) return transferEncoding === undefined ? null : { statusCode: 411, code: 'LENGTH_REQUIRED' }
  return Number(contentLength) > MAX_PROXIED_BODY_BYTES ? { statusCode: 413, code: 'BODY_TOO_LARGE' } : null
}

/**
 * The visitor's address as the API should see it: the nearest hop of `X-Forwarded-For` when this app itself runs
 * behind one trusted proxy, otherwise the connection's own address — never an address the visitor chose.
 */
export function visitorAddress(forwardedFor: string | undefined, socketAddress: string | undefined, trustProxy: boolean): string {
  const nearest = trustProxy ? forwardedFor?.split(',').map(part => part.trim()).filter(Boolean).at(-1) : undefined
  return nearest ?? socketAddress ?? 'unknown'
}

/**
 * The headers the proxy sets on every forwarded request (h3 lets them replace any the visitor sent). The visitor's
 * address goes twice: in X-Forwarded-For, and in a header of our own that a hop between the proxy and the API (a
 * Vercel service binding) does not rewrite — the API reads that one with TRUST_VISITOR_HEADER=true.
 */
export function forwardedHeaders(visitor: string, host: string, protocol: string): Record<string, string> {
  return { 'x-forwarded-for': visitor, [VISITOR_ADDRESS_HEADER]: visitor, 'x-forwarded-host': host, 'x-forwarded-proto': protocol }
}
