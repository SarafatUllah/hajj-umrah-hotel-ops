import type { AuditRepository } from '../repositories/tenant/auditRepository'
import type { AuditAction } from '../../shared/constants/audit'

export interface AuditEntry {
  hotelId?: string | null
  entityType: string
  entityId: string
  action: AuditAction
  before?: unknown
  after?: unknown
  reason?: string
}

/** Keys redacted at any depth, regardless of casing convention (camelCase or snake_case source). */
const REDACTED_KEYS = new Set(['password', 'passwordHash', 'password_hash', 'token', 'secret'])

function replacer(key: string, value: unknown): unknown {
  if (REDACTED_KEYS.has(key)) return undefined // omits the property entirely (or nulls it inside an array)
  if (value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  return value
}

/**
 * Redacts secret-shaped keys at any depth and round-trips through JSON so a `Date`, `BigInt`, or
 * any other value `pg`/Drizzle cannot insert into `jsonb` as-is can never break the audit write.
 */
function toJsonb(value: unknown): unknown {
  if (value === undefined) return null
  const serialized = JSON.stringify(value, replacer)
  return serialized === undefined ? null : JSON.parse(serialized) as unknown
}

/**
 * The single writer for `audit_log` (D-invariant: every audit row is written through this
 * function, never a raw repository call, so redaction can never be forgotten at a call site).
 */
export async function recordAudit(audit: AuditRepository, actorUserId: string, entry: AuditEntry): Promise<void> {
  await audit.record({
    hotelId: entry.hotelId ?? null,
    actorUserId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    beforeData: toJsonb(entry.before),
    afterData: toJsonb(entry.after),
    reason: entry.reason ?? null,
  })
}
