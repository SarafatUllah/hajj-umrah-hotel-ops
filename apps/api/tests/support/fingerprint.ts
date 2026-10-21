import { createHash } from 'node:crypto'
import { eq, inArray, type SQL } from 'drizzle-orm'
import { getTableColumns, getTableName } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import type { DbOrTx } from '../../db/client'
import { appUser, capacityPeriod, floor, hotel, hotelSetting, role, rolePermission, room, roomBaseConfig, roomCapacityOverride, roomOperationalBlock, roomType, userHotelAccess, userRole } from '../../db/schema'

/**
 * A SHA-256 fingerprint of an organization's BUSINESS state, for determinism and reset tests.
 *
 * Covered (every row of the organization, ordered canonically so insertion/physical order never matters):
 * hotels, floors, room types, rooms, base versions, capacity periods, overrides, operational blocks, users,
 * roles, role permissions, user-role links, hotel-access rows and hotel settings.
 *
 * Excluded columns (non-deterministic, never business data):
 *  - `created_at` / `updated_at`: database wall-clock defaults;
 *  - `app_user.password_hash`: a salted Argon2 hash differs on every seed even for the same password
 *    (that the password still verifies is asserted separately through the real login service).
 * Kept on purpose: every business date and the deterministic business timestamps the seed writes
 * (`cancelled_at`, `ended_early_at`), all ids, and every foreign key.
 * Not covered: audit_log (a reset legitimately adds a DEMO_RESET row) and documents (separate tests).
 */
const VOLATILE_COLUMNS = new Set(['createdAt', 'updatedAt', 'passwordHash'])

interface TableSpec {
  table: PgTable
  /** Rows of the organization: either by its own organization_id column, or through the ids of its roles. */
  where: (organizationId: string, roleIds: string[]) => SQL
}

const byOrganization = (column: { name: string }) => ((organizationId: string) => eq(column as never, organizationId))

function specs(): TableSpec[] {
  const orgScoped = (table: PgTable & { organizationId: { name: string } }): TableSpec => ({ table, where: byOrganization(table.organizationId) })
  return [
    orgScoped(hotel), orgScoped(floor), orgScoped(roomType), orgScoped(room), orgScoped(roomBaseConfig), orgScoped(capacityPeriod),
    orgScoped(roomCapacityOverride), orgScoped(roomOperationalBlock), orgScoped(appUser), orgScoped(role), orgScoped(userRole),
    orgScoped(userHotelAccess), orgScoped(hotelSetting),
    { table: rolePermission, where: (_org, roleIds) => inArray(rolePermission.roleId, roleIds) },
  ]
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]))
  }
  return value
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export interface OrganizationFingerprint {
  /** The single hash over every table. */
  hash: string
  /** Per-table row count and hash, to see WHICH table differs when two fingerprints do not match. */
  tables: Record<string, { rows: number, hash: string }>
}

export async function fingerprintOrganization(db: DbOrTx, organizationId: string): Promise<OrganizationFingerprint> {
  const roleIds = (await db.select({ id: role.id }).from(role).where(eq(role.organizationId, organizationId))).map(r => r.id)
  const tables: OrganizationFingerprint['tables'] = {}
  for (const { table, where } of specs()) {
    const name = getTableName(table)
    const columns = Object.keys(getTableColumns(table))
    const rows = roleIds.length === 0 && table === rolePermission ? [] : await db.select().from(table).where(where(organizationId, roleIds))
    const serialized = rows
      .map(row => JSON.stringify(canonical(Object.fromEntries(columns.filter(c => !VOLATILE_COLUMNS.has(c)).map(c => [c, (row as Record<string, unknown>)[c]])))))
      .sort()
    tables[name] = { rows: serialized.length, hash: sha256(serialized.join('\n')) }
  }
  const hash = sha256(Object.entries(tables).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, t]) => `${name}:${t.rows}:${t.hash}`).join('\n'))
  return { hash, tables }
}
