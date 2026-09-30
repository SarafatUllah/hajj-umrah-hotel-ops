import { asc, count, eq } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { floor } from '../../../db/schema'
import type { HotelScope } from '../../security/scope'
import { HotelQuery } from '../base/scopedQuery'

export type FloorRow = typeof floor.$inferSelect
/** `organizationId`/`hotelId` are supplied by the scope, never the caller (HotelQuery.insert). */
export type NewFloor = Omit<typeof floor.$inferInsert, 'organizationId' | 'hotelId'>
/** `id`/`organizationId`/`hotelId` are never client-settable via a patch. */
export type FloorPatch = Partial<Omit<typeof floor.$inferInsert, 'id' | 'organizationId' | 'hotelId'>>

export class FloorRepository {
  private readonly q: HotelQuery

  constructor(private readonly db: DbOrTx, private readonly scope: HotelScope) {
    this.q = new HotelQuery(db, scope)
  }

  async insert(values: NewFloor): Promise<FloorRow> {
    const [row] = await this.q.insert(floor, values).returning()
    return row!
  }

  /** Multi-row insert for bulk creation — one INSERT statement, all rows scoped to the same hotel. */
  async insertMany(valuesList: readonly NewFloor[]): Promise<FloorRow[]> {
    if (valuesList.length === 0) return []
    return this.q.insertMany(floor, valuesList).returning()
  }

  async findById(id: string): Promise<FloorRow | null> {
    const [row] = await this.q.select(floor, eq(floor.id, id), { limit: 1 })
    return row ?? null
  }

  async findByLevel(level: number): Promise<FloorRow | null> {
    const [row] = await this.q.select(floor, eq(floor.level, level), { limit: 1 })
    return row ?? null
  }

  async list(options: { includeInactive?: boolean } = {}): Promise<FloorRow[]> {
    const where = options.includeInactive ? undefined : eq(floor.isActive, true)
    return this.q.select(floor, where, { orderBy: [asc(floor.level)] })
  }

  async update(id: string, patch: FloorPatch): Promise<void> {
    await this.q.update(floor, patch, eq(floor.id, id))
  }

  async setActive(id: string, isActive: boolean): Promise<void> {
    await this.q.update(floor, { isActive }, eq(floor.id, id))
  }

  /** Total floor count for this hotel scope (general-purpose; `includeInactive` defaults to counting active floors only). */
  async countByHotel(includeInactive = false): Promise<number> {
    const where = includeInactive ? undefined : eq(floor.isActive, true)
    const [row] = await this.db.select({ value: count() }).from(floor).where(this.q.cond(floor, where))
    return Number(row?.value ?? 0)
  }
}
