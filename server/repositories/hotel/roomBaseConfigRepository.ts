import { asc, eq, inArray } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { roomBaseConfig } from '../../../db/schema'
import type { HotelScope } from '../../security/scope'
import type { IsoDate } from '../../../shared/utils/dates'
import { HotelQuery } from '../base/scopedQuery'

export type RoomBaseConfigRow = typeof roomBaseConfig.$inferSelect
/** `organizationId`/`hotelId` are supplied by the scope, never the caller. */
export type NewRoomBaseConfig = Omit<typeof roomBaseConfig.$inferInsert, 'organizationId' | 'hotelId'>

/**
 * A room's versioned base-capacity history. Every write here either closes an already-open version's
 * `valid_to` (`closeVersion`) or inserts a brand-new open-ended version (`insert`/`insertMany`) —
 * there is no method that mutates any OTHER field of an existing row, so history can never be
 * rewritten from this layer either (on top of the DB's own exclusion constraint, which is the final
 * arbiter against a concurrent overlapping write).
 */
export class RoomBaseConfigRepository {
  private readonly q: HotelQuery

  constructor(private readonly db: DbOrTx, private readonly scope: HotelScope) {
    this.q = new HotelQuery(db, scope)
  }

  async insert(values: NewRoomBaseConfig): Promise<RoomBaseConfigRow> {
    const [row] = await this.q.insert(roomBaseConfig, values).returning()
    return row!
  }

  /** Multi-row insert for bulk creation — one INSERT statement, all rows scoped to the same hotel. */
  async insertMany(valuesList: readonly NewRoomBaseConfig[]): Promise<RoomBaseConfigRow[]> {
    if (valuesList.length === 0) return []
    return this.q.insertMany(roomBaseConfig, valuesList).returning()
  }

  /** Full history for one room, oldest first. */
  async versionsForRoom(roomId: string): Promise<RoomBaseConfigRow[]> {
    return this.q.select(roomBaseConfig, eq(roomBaseConfig.roomId, roomId), { orderBy: [asc(roomBaseConfig.validFrom)] })
  }

  /** Full history for every room in `roomIds`, oldest first — ONE query for a whole list page (never one per room). */
  async versionsForRooms(roomIds: readonly string[]): Promise<RoomBaseConfigRow[]> {
    if (roomIds.length === 0) return []
    return this.q.select(roomBaseConfig, inArray(roomBaseConfig.roomId, roomIds as string[]), { orderBy: [asc(roomBaseConfig.validFrom)] })
  }

  /** Closes the currently-open version at `validTo` — the ONLY field a base-config row is ever updated on. */
  async closeVersion(id: string, validTo: IsoDate): Promise<void> {
    await this.q.update(roomBaseConfig, { validTo }, eq(roomBaseConfig.id, id))
  }
}
