import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { roomCapacityOverride } from '../../../db/schema'
import type { HotelScope } from '../../security/scope'
import type { IsoDate, NightRange } from '../../../shared/utils/dates'
import { HotelQuery } from '../base/scopedQuery'

export type RoomCapacityOverrideRow = typeof roomCapacityOverride.$inferSelect
/** `organizationId`/`hotelId` are supplied by the scope, never the caller. */
export type NewRoomCapacityOverride = Omit<typeof roomCapacityOverride.$inferInsert, 'organizationId' | 'hotelId'>

/**
 * A room's seasonal overrides. There is no `update()` here — an override's dates are only ever
 * changed by the FK cascade off its period's own dates (Task 15's `room_override_period_dates_fk
 * ON UPDATE CASCADE`), never a direct write from this layer; its beds/capacity are immutable once
 * applied (change it by removing and re-applying).
 */
export class RoomCapacityOverrideRepository {
  private readonly q: HotelQuery

  constructor(private readonly db: DbOrTx, private readonly scope: HotelScope) {
    this.q = new HotelQuery(db, scope)
  }

  /** Multi-row insert for a bulk override application — one INSERT statement, all rows scoped to the same hotel. */
  async insertMany(valuesList: readonly NewRoomCapacityOverride[]): Promise<RoomCapacityOverrideRow[]> {
    if (valuesList.length === 0) return []
    return this.q.insertMany(roomCapacityOverride, valuesList).returning()
  }

  /** Every override belonging to one period, oldest-applied first. */
  async findByPeriod(periodId: string): Promise<RoomCapacityOverrideRow[]> {
    return this.q.select(roomCapacityOverride, eq(roomCapacityOverride.periodId, periodId), { orderBy: [asc(roomCapacityOverride.validFrom)] })
  }

  /** Every override of this hotel, across every period — the period LIST's batched impact computation (S7), never one query per period. */
  async listAll(): Promise<RoomCapacityOverrideRow[]> {
    return this.q.select(roomCapacityOverride)
  }

  /** Overrides of the given rooms whose range intersects `range` — used for effective-capacity reads (preview, timeline, DTOs). */
  async findByRoomIds(roomIds: readonly string[], range: NightRange): Promise<RoomCapacityOverrideRow[]> {
    if (roomIds.length === 0) return []
    return this.q.select(roomCapacityOverride, and(
      inArray(roomCapacityOverride.roomId, roomIds as string[]),
      lte(roomCapacityOverride.validFrom, range.to),
      gte(roomCapacityOverride.validTo, range.from),
    ))
  }

  /** Full override history for one room (S5 — `RoomDetail.seasons`), oldest first. */
  async findAllForRoom(roomId: string): Promise<RoomCapacityOverrideRow[]> {
    return this.q.select(roomCapacityOverride, eq(roomCapacityOverride.roomId, roomId), { orderBy: [asc(roomCapacityOverride.validFrom)] })
  }

  /** Overrides of the given rooms that overlap `range`, across ANY period — the ALREADY_OVERRIDDEN pre-check before applying a new one. */
  async findOverlapping(roomIds: readonly string[], range: NightRange): Promise<RoomCapacityOverrideRow[]> {
    return this.findByRoomIds(roomIds, range)
  }

  async findByIdsInPeriod(periodId: string, ids: readonly string[]): Promise<RoomCapacityOverrideRow[]> {
    if (ids.length === 0) return []
    return this.q.select(roomCapacityOverride, and(eq(roomCapacityOverride.periodId, periodId), inArray(roomCapacityOverride.id, ids as string[])))
  }

  async deleteById(id: string): Promise<void> {
    await this.q.delete(roomCapacityOverride, eq(roomCapacityOverride.id, id))
  }

  /** Bulk removal (S8) — one DELETE statement for every id. */
  async deleteByIds(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    await this.q.delete(roomCapacityOverride, inArray(roomCapacityOverride.id, ids as string[]))
  }

  /** True if the room has an override ending on or after `date` — the retire guard (409 ROOM_HAS_FUTURE_OVERRIDES). */
  async existsEndingOnOrAfter(roomId: string, date: IsoDate): Promise<boolean> {
    const rows = await this.q.select(roomCapacityOverride, and(eq(roomCapacityOverride.roomId, roomId), gte(roomCapacityOverride.validTo, date)), { limit: 1 })
    return rows.length > 0
  }
}
