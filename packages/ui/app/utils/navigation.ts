const FIRST_PRINTABLE = 0x20

/** Where to go after signing in: only a path of this site (never another origin, nor one a browser would read so). */
export function safeRedirect(target: unknown, fallback = '/'): string {
  if (typeof target !== 'string' || !target.startsWith('/')) return fallback
  // `//host`, `/\host` and control characters (browsers drop tabs and newlines: `/\t/host` is `//host`).
  const controlled = [...target].some(character => character.charCodeAt(0) < FIRST_PRINTABLE)
  return controlled || target.startsWith('//') || target.includes('\\') ? fallback : target
}
