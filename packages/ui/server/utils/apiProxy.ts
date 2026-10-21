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

/** Tabs, newlines and the other C0 controls: never part of a path the app builds. */
const FIRST_PRINTABLE = 0x20
export const hasControlCharacter = (text: string): boolean => [...text].some(character => character.charCodeAt(0) < FIRST_PRINTABLE)

/**
 * The visitor's address as the API should see it: the nearest hop of `X-Forwarded-For` when this app itself runs
 * behind one trusted proxy, otherwise the connection's own address — never an address the visitor chose.
 */
export function visitorAddress(forwardedFor: string | undefined, socketAddress: string | undefined, trustProxy: boolean): string {
  const nearest = trustProxy ? forwardedFor?.split(',').map(part => part.trim()).filter(Boolean).at(-1) : undefined
  return nearest ?? socketAddress ?? 'unknown'
}
