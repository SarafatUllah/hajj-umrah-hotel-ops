import { and, asc, count, eq, gte, inArray } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { capacityPeriod, roomCapacityOverride } from '../../../db/schema'
import type { HotelScope } from '../../security/scope'
import type { IsoDate } from '../../../shared/utils/dates'
import { HotelQuery } from '../base/scopedQuery'

export type CapacityPeriodRow = typeof capacityPeriod.$inferSelect
/** `organizationId`/`hotelId` are supplied by the scope, never the caller. */
export type NewCapacityPeriod = Omit<typeof capacityPeriod.$inferInsert, 'organizationId' | 'hotelId'>
/** `id`/`organizationId`/`hotelId`/`createdAt` are never client-settable via a patch. */
export type CapacityPeriodPatch = Partial<Omit<typeof capacityPeriod.$inferInsert, 'id' | 'organizationId' | 'hotelId' | 'createdAt'>>

export class CapacityPeriodRepository {
  private readonly q: HotelQuery

  constructor(private readonly db: DbOrTx, private readonly scope: HotelScope) {
    this.q = new HotelQuery(db, scope)
  }

  async insert(values: NewCapacityPeriod): Promise<CapacityPeriodRow> {
    const [row] = await this.q.insert(capacityPeriod, values).returning()
    return row!
  }

  async findById(id: string): Promise<CapacityPeriodRow | null> {
    const [row] = await this.q.select(capacityPeriod, eq(capacityPeriod.id, id), { limit: 1 })
    return row ?? null
  }

  /** `includePast=false` (default) excludes periods that have already ended as of `today`; ordered by start date. */
  async list(options: { includePast?: boolean, today: IsoDate }): Promise<CapacityPeriodRow[]> {
    const where = options.includePast ? undefined : gte(capacityPeriod.endDate, options.today)
    return this.q.select(capacityPeriod, where, { orderBy: [asc(capacityPeriod.startDate)] })
  }

  /** Batched period-ref lookup for DTOs (S5/S13) — one query for every id a caller already has. */
  async findByIds(ids: readonly string[]): Promise<CapacityPeriodRow[]> {
    if (ids.length === 0) return []
    return this.q.select(capacityPeriod, inArray(capacityPeriod.id, ids as string[]))
  }

  async update(id: string, patch: CapacityPeriodPatch): Promise<void> {
    await this.q.update(capacityPeriod, patch, eq(capacityPeriod.id, id))
  }

  async delete(id: string): Promise<void> {
    await this.q.delete(capacityPeriod, eq(capacityPeriod.id, id))
  }

  async countOverrides(periodId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(roomCapacityOverride)
      .where(and(eq(roomCapacityOverride.organizationId, this.scope.organizationId), eq(roomCapacityOverride.hotelId, this.scope.hotelId), eq(roomCapacityOverride.periodId, periodId)))
    return Number(row?.value ?? 0)
  }

  /** Override counts for EVERY period of this hotel, grouped in ONE query (S7 — never one per period in a list). */
  async overrideCountsByPeriod(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ periodId: roomCapacityOverride.periodId, value: count() })
      .from(roomCapacityOverride)
      .where(and(eq(roomCapacityOverride.organizationId, this.scope.organizationId), eq(roomCapacityOverride.hotelId, this.scope.hotelId)))
      .groupBy(roomCapacityOverride.periodId)
    return new Map(rows.map(r => [r.periodId, Number(r.value)]))
  }
}
