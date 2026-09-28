import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { appUser, auditLog } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type AuditLogRow = typeof auditLog.$inferSelect
export type NewAuditEntry = Omit<typeof auditLog.$inferInsert, 'organizationId' | 'id' | 'createdAt'>

export interface AuditActor { id: string, fullName: string }
export type AuditRowWithActor = AuditLogRow & { actor: AuditActor | null }

/**
 * Opaque-cursor pagination key. `createdAt` is the full-precision Postgres text representation
 * (`created_at::text`, microsecond precision) rather than a JS `Date`/ISO string truncated to
 * milliseconds — two audit rows created within the same millisecond would otherwise be
 * indistinguishable to the cursor and one could be silently skipped or repeated across pages.
 */
export interface AuditCursor { createdAt: string, id: string }

export interface ListAuditOptions {
  entityType?: string
  entityId?: string
  action?: string
  cursor?: AuditCursor
  limit: number
}

export interface AuditPage { rows: AuditRowWithActor[], nextCursor: AuditCursor | null }

export class AuditRepository {
  private readonly q: OrgQuery

  constructor(private readonly db: DbOrTx, private readonly scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async record(entry: NewAuditEntry): Promise<void> {
    await this.q.insert(auditLog, entry)
  }

  /** Hotel-scoped history — `entity_idx`/`org_hotel_time_idx` cover the predicates below. */
  async listForHotel(hotelId: string, options: ListAuditOptions): Promise<AuditPage> {
    return this.#list(eq(auditLog.hotelId, hotelId), options)
  }

  /** Organization-level entries (no hotel — e.g. DEMO_RESET). */
  async listOrganizationLevel(options: ListAuditOptions): Promise<AuditPage> {
    return this.#list(isNull(auditLog.hotelId), options)
  }

  // True JS-private (not TypeScript `private`, which is erased at runtime and would still show up
  // as an enumerable prototype method to the isolation-registry coverage scan in repositoryRegistry.ts).
  async #list(hotelCond: SQL, options: ListAuditOptions): Promise<AuditPage> {
    const conditions: Array<SQL | undefined> = [hotelCond]
    if (options.entityType) conditions.push(eq(auditLog.entityType, options.entityType))
    if (options.entityId) conditions.push(eq(auditLog.entityId, options.entityId))
    if (options.action) conditions.push(eq(auditLog.action, options.action))
    if (options.cursor) {
      // Row-value comparison (PF-7): a plain `created_at < $1 OR (created_at = $1 AND id < $2)`
      // pair would work too, but the row-value form is what was verified against the index.
      conditions.push(sql`(${auditLog.createdAt}, ${auditLog.id}) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id}::uuid)`)
    }

    const rows = await this.db
      .select({
        id: auditLog.id,
        organizationId: auditLog.organizationId,
        hotelId: auditLog.hotelId,
        actorUserId: auditLog.actorUserId,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        action: auditLog.action,
        beforeData: auditLog.beforeData,
        afterData: auditLog.afterData,
        reason: auditLog.reason,
        createdAt: auditLog.createdAt,
        cursorCreatedAt: sql<string>`${auditLog.createdAt}::text`,
        actorId: appUser.id,
        actorFullName: appUser.fullName,
      })
      .from(auditLog)
      // Constrained to the same organization (S3): a corrupt/legacy actor_user_id could otherwise
      // resolve to a same-id user in a different organization.
      .leftJoin(appUser, and(eq(appUser.id, auditLog.actorUserId), eq(appUser.organizationId, this.scope.organizationId)))
      .where(this.q.cond(auditLog, ...conditions))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(options.limit)

    const mapped: AuditRowWithActor[] = rows.map(r => ({
      id: r.id,
      organizationId: r.organizationId,
      hotelId: r.hotelId,
      actorUserId: r.actorUserId,
      entityType: r.entityType,
      entityId: r.entityId,
      action: r.action,
      beforeData: r.beforeData,
      afterData: r.afterData,
      reason: r.reason,
      createdAt: r.createdAt,
      actor: r.actorId ? { id: r.actorId, fullName: r.actorFullName! } : null,
    }))

    const last = rows.at(-1)
    const nextCursor: AuditCursor | null = rows.length === options.limit && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null

    return { rows: mapped, nextCursor }
  }
}
