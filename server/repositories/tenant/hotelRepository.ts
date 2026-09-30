import { and, count, eq, inArray } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { floor, hotel } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type HotelRow = typeof hotel.$inferSelect
export type NewHotel = Omit<typeof hotel.$inferInsert, 'organizationId'>
/** `code` is immutable after creation (domain rule); `id`/`organizationId` are never client-settable. */
export type HotelPatch = Partial<Omit<typeof hotel.$inferInsert, 'id' | 'organizationId' | 'code'>>

export class HotelRepository {
  private readonly q: OrgQuery

  constructor(private readonly db: DbOrTx, private readonly scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async insert(values: NewHotel): Promise<HotelRow> {
    const [row] = await this.q.insert(hotel, values).returning()
    return row!
  }

  async findById(id: string): Promise<HotelRow | null> {
    const [row] = await this.q.select(hotel, eq(hotel.id, id), { limit: 1 })
    return row ?? null
  }

  async findByCode(code: string): Promise<HotelRow | null> {
    const [row] = await this.q.select(hotel, eq(hotel.code, code), { limit: 1 })
    return row ?? null
  }

  async listByIds(ids: readonly string[]): Promise<HotelRow[]> {
    if (ids.length === 0) return []
    return this.q.select(hotel, inArray(hotel.id, ids as string[]))
  }

  async listAll(): Promise<HotelRow[]> {
    return this.q.select(hotel)
  }

  async update(id: string, patch: HotelPatch): Promise<void> {
    await this.q.update(hotel, patch, eq(hotel.id, id))
  }

  async setStatus(id: string, status: string): Promise<void> {
    await this.q.update(hotel, { status }, eq(hotel.id, id))
  }

  /**
   * PF-13: active-floor counts for every id in `hotelIds`, grouped in ONE query (not one per hotel) —
   * lives here rather than on `FloorRepository` because it must aggregate across multiple hotels for
   * the `GET /api/hotels` list endpoint, which `FloorRepository`'s single-`HotelScope` construction
   * cannot express. A hotel with zero active floors (or one this scope's organization does not own)
   * is simply absent from the returned map — callers default to 0, never throw.
   */
  async activeFloorCounts(hotelIds: readonly string[]): Promise<Map<string, number>> {
    if (hotelIds.length === 0) return new Map()
    const rows = await this.db
      .select({ hotelId: floor.hotelId, value: count() })
      .from(floor)
      .where(and(eq(floor.organizationId, this.scope.organizationId), inArray(floor.hotelId, hotelIds as string[]), eq(floor.isActive, true)))
      .groupBy(floor.hotelId)
    return new Map(rows.map(r => [r.hotelId, Number(r.value)]))
  }
}
