import { asc, eq, inArray, sql } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { room, roomBaseConfig, roomType } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import type { IsoDate } from '../../../shared/utils/dates'
import { OrgQuery } from '../base/scopedQuery'

export type RoomTypeRow = typeof roomType.$inferSelect
export type NewRoomType = Omit<typeof roomType.$inferInsert, 'organizationId'>
/** `id`/`organizationId` are never client-settable via a patch. */
export type RoomTypePatch = Partial<Omit<typeof roomType.$inferInsert, 'id' | 'organizationId'>>

/** Organization-wide catalog (not hotel-scoped) — every statement is confined to `scope.organizationId`. */
export class RoomTypeRepository {
  private readonly q: OrgQuery

  constructor(private readonly db: DbOrTx, private readonly scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async insert(values: NewRoomType): Promise<RoomTypeRow> {
    const [row] = await this.q.insert(roomType, values).returning()
    return row!
  }

  async findById(id: string): Promise<RoomTypeRow | null> {
    const [row] = await this.q.select(roomType, eq(roomType.id, id), { limit: 1 })
    return row ?? null
  }

  /** Bulk id lookup, organization-scoped — Task 15's `roomTypeIds` override selector validates every id in ONE query (same pattern as `RoomRepository.findByIds`). */
  async findByIds(ids: readonly string[]): Promise<RoomTypeRow[]> {
    if (ids.length === 0) return []
    return this.q.select(roomType, inArray(roomType.id, ids as string[]))
  }

  async findByCode(code: string): Promise<RoomTypeRow | null> {
    const [row] = await this.q.select(roomType, eq(roomType.code, code), { limit: 1 })
    return row ?? null
  }

  async list(options: { includeInactive?: boolean } = {}): Promise<RoomTypeRow[]> {
    const where = options.includeInactive ? undefined : eq(roomType.isActive, true)
    return this.q.select(roomType, where, { orderBy: [asc(roomType.sortOrder), asc(roomType.name)] })
  }

  async update(id: string, patch: RoomTypePatch): Promise<void> {
    await this.q.update(roomType, patch, eq(roomType.id, id))
  }

  async setActive(id: string, isActive: boolean): Promise<void> {
    await this.q.update(roomType, { isActive }, eq(roomType.id, id))
  }

  /**
   * Rooms in inventory (a base-config version covering that room's OWN hotel's local `asOf`) per room
   * type, ACROSS THE WHOLE ORGANIZATION (every hotel) — ONE grouped query, never one per hotel or per
   * room type. Used only for an `allHotels` caller (Task 14 PF-13-style information-hiding rule: a
   * hotel-scoped caller must never learn organization-wide usage of a catalog entry, so the SERVICE
   * never calls this method for them at all).
   *
   * Mirrors `HotelRepository.roomCounts`' VALUES-join technique exactly (fix round 1): every hotel in
   * the organization can be in a different IANA timezone, so a single shared `asOf` is wrong for at
   * least one hotel whenever two hotels' local dates diverge (e.g. the ~3-hour daily window where
   * UTC's "today" is still "yesterday" relative to `Asia/Riyadh`). The per-hotel `asOf` values are
   * joined in via a `VALUES` table and correlated against `room`/`room_base_config` in one statement.
   */
  async usageCounts(hotelTodays: ReadonlyArray<{ hotelId: string, asOf: IsoDate }>): Promise<Map<string, number>> {
    if (hotelTodays.length === 0) return new Map()
    const valuesSql = sql.join(hotelTodays.map(h => sql`(${h.hotelId}::uuid, ${h.asOf}::date)`), sql`, `)
    const rows = await this.db.execute<{ room_type_id: string, value: number }>(sql`
      SELECT ${room.roomTypeId} AS room_type_id, count(*)::int AS value
      FROM (VALUES ${valuesSql}) AS v(hotel_id, as_of)
      JOIN ${room} ON ${room.hotelId} = v.hotel_id AND ${room.organizationId} = ${this.scope.organizationId}
      JOIN ${roomBaseConfig} ON ${roomBaseConfig.roomId} = ${room.id}
        AND ${roomBaseConfig.validFrom} <= v.as_of
        AND (${roomBaseConfig.validTo} IS NULL OR ${roomBaseConfig.validTo} >= v.as_of)
      GROUP BY ${room.roomTypeId}
    `)
    return new Map([...rows].map(r => [r.room_type_id, Number(r.value)]))
  }
}
