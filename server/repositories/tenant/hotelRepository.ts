import { and, count, eq, inArray, sql } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { floor, hotel, room, roomBaseConfig } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import type { IsoDate } from '../../../shared/utils/dates'
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

  /**
   * Task 14: rooms in inventory per hotel, ONE query for the whole `hotelTodays` list (not one per
   * hotel) — despite each hotel needing its OWN local "today" (different hotels can be in different
   * IANA timezones, so a single shared `asOf` would be wrong for at least one of them whenever two
   * hotels' local dates diverge, e.g. near midnight). The per-hotel `asOf` values are joined in via a
   * `VALUES` table and correlated against `room`/`room_base_config` in one statement, rather than
   * grouping hotels by timezone and issuing one query per group. A hotel with zero rooms in inventory
   * (or one this scope's organization does not own) is simply absent from the returned map.
   */
  async roomCounts(hotelTodays: ReadonlyArray<{ hotelId: string, asOf: IsoDate }>): Promise<Map<string, number>> {
    if (hotelTodays.length === 0) return new Map()
    const valuesSql = sql.join(hotelTodays.map(h => sql`(${h.hotelId}::uuid, ${h.asOf}::date)`), sql`, `)
    const rows = await this.db.execute<{ hotel_id: string, value: number }>(sql`
      SELECT v.hotel_id AS hotel_id, count(*)::int AS value
      FROM (VALUES ${valuesSql}) AS v(hotel_id, as_of)
      JOIN ${room} ON ${room.hotelId} = v.hotel_id AND ${room.organizationId} = ${this.scope.organizationId}
      JOIN ${roomBaseConfig} ON ${roomBaseConfig.roomId} = ${room.id}
        AND ${roomBaseConfig.validFrom} <= v.as_of
        AND (${roomBaseConfig.validTo} IS NULL OR ${roomBaseConfig.validTo} >= v.as_of)
      GROUP BY v.hotel_id
    `)
    return new Map([...rows].map(r => [r.hotel_id, Number(r.value)]))
  }
}
