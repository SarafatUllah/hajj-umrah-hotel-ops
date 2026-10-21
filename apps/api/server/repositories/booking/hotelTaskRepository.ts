import { and, asc, eq, gte, inArray, isNotNull, lte, type SQL } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { hotelTask, room } from '@hajj/db/schema'
import type { HotelTaskStatus } from '@hajj/contracts/constants/booking'
import type { IsoDate } from '@hajj/contracts/utils/dates'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type HotelTaskRow = typeof hotelTask.$inferSelect
export type NewHotelTask = Omit<typeof hotelTask.$inferInsert, 'organizationId' | 'id' | 'status' | 'doneAt' | 'doneBy' | 'createdAt' | 'updatedAt'>

/** A task with the room it is for. */
export interface HotelTaskListRow { task: HotelTaskRow, roomNumber: string }

export interface HotelTaskFilter {
  hotelId: string
  status?: HotelTaskStatus
  /** Due on or after / on or before (inclusive). */
  from?: IsoDate
  to?: IsoDate
  limit: number
}

/** Housekeeping work the bookings create (v7 §11: "room 412: put 1 extra bed before the 15th"), per hotel. */
export class HotelTaskRepository {
  readonly #q: OrgQuery

  constructor(private readonly db: DbOrTx, scope: OrganizationScope) {
    this.#q = new OrgQuery(db, scope)
  }

  async insertMany(tasks: readonly NewHotelTask[]): Promise<HotelTaskRow[]> {
    if (tasks.length === 0) return []
    return this.#q.insertMany(hotelTask, tasks).returning()
  }

  /** One hotel's tasks, the soonest due first. */
  async list(filter: HotelTaskFilter): Promise<HotelTaskListRow[]> {
    const conditions: SQL[] = [eq(hotelTask.hotelId, filter.hotelId)]
    if (filter.status) conditions.push(eq(hotelTask.status, filter.status))
    if (filter.from) conditions.push(gte(hotelTask.dueDate, filter.from))
    if (filter.to) conditions.push(lte(hotelTask.dueDate, filter.to))
    return this.#withRoom(conditions).orderBy(asc(hotelTask.dueDate), asc(room.roomNumber), asc(hotelTask.id)).limit(filter.limit)
  }

  async findById(id: string, hotelId: string): Promise<HotelTaskListRow | null> {
    const [row] = await this.#withRoom([eq(hotelTask.id, id), eq(hotelTask.hotelId, hotelId)]).limit(1)
    return row ?? null
  }

  #withRoom(conditions: SQL[]) {
    return this.db.select({ task: hotelTask, roomNumber: room.roomNumber }).from(hotelTask)
      .innerJoin(room, and(eq(room.organizationId, hotelTask.organizationId), eq(room.hotelId, hotelTask.hotelId), eq(room.id, hotelTask.roomId)))
      .where(this.#q.cond(hotelTask, ...conditions))
      .$dynamic()
  }

  /** Ticket 4: the notes on these bookings' tasks may name people: cleared. */
  async clearNotes(bookingIds: readonly string[]): Promise<void> {
    if (bookingIds.length === 0) return
    await this.#q.update(hotelTask, { notes: null }, inArray(hotelTask.bookingId, [...bookingIds]), isNotNull(hotelTask.notes))
  }

  /** v7 §12: the open tasks of a cancelled booking are not needed any more. Returns how many. */
  async cancelOpenForBooking(bookingId: string, at: Date): Promise<number> {
    const rows = await this.#q.update(hotelTask, { status: 'CANCELLED', updatedAt: at }, eq(hotelTask.bookingId, bookingId), eq(hotelTask.status, 'OPEN')).returning({ id: hotelTask.id })
    return rows.length
  }

  /** OPEN → DONE for a task of this hotel; null when it is not open (done or cancelled meanwhile) or not this hotel's. */
  async markDone(id: string, hotelId: string, done: { by: string, at: Date }): Promise<HotelTaskRow | null> {
    const [row] = await this.#q.update(hotelTask, { status: 'DONE', doneAt: done.at, doneBy: done.by, updatedAt: done.at }, eq(hotelTask.id, id), eq(hotelTask.hotelId, hotelId), eq(hotelTask.status, 'OPEN')).returning()
    return row ?? null
  }
}
