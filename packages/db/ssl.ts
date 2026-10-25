import type { ConnectionOptions } from 'node:tls'

/** TLS options for a PostgreSQL connection (postgres.js and pg take the same shape), or false for a plain one. */
export type DatabaseSsl = false | ConnectionOptions

export const DATABASE_SSL_MODES = ['off', 'require', 'verify'] as const

/**
 * How every database connection uses TLS (`DATABASE_SSL`; `DATABASE_SSL_CA` is the PEM certificate of the CA to trust
 * with `verify`, e.g. Supabase's): `off` (default: a local database), `verify` (encrypted, and the server's certificate
 * checked — the one to use), `require` (encrypted but not checked, like libpq's `sslmode=require`: only when the
 * provider's certificate cannot be verified). One setting for the app's pool, pg-boss and the scripts, so no connection
 * is left in clear text; keep `sslmode` out of DATABASE_URL (pg would let it override this).
 */
export function databaseSsl(source: Record<string, string | undefined> = process.env): DatabaseSsl {
  const mode = source.DATABASE_SSL?.trim() || 'off'
  if (mode === 'off') return false
  if (mode === 'require') return { rejectUnauthorized: false }
  if (mode === 'verify') {
    // A certificate pasted on one line (`\n` escapes) is read as the multi-line PEM it stands for.
    const ca = source.DATABASE_SSL_CA?.replaceAll('\\n', '\n').trim()
    return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true }
  }
  throw new Error(`DATABASE_SSL must be off, require or verify (got ${JSON.stringify(mode)})`)
}
