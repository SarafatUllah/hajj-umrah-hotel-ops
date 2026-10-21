import type { HotelTaskKind, HotelTaskStatus } from '@hajj/contracts/constants/booking'
import type { HotelTaskQuery } from '@hajj/contracts/schemas/booking'
import { extraBedTasks } from '../../domain/booking/hotelTasks'
import { ConflictError, NotFoundError } from '../../errors/domainError'
import { bookingOrgRepos } from '../../repositories'
import type { BookingRow, HotelTaskListRow } from '../../repositories/booking'
import type { AuthContext } from '../../security/authContext'
import { authorizeHotel } from '../../security/authorize'
import type { OrganizationScope } from '../../security/scope'

type Db = Parameters<typeof bookingOrgRepos>[0]

/** A housekeeping task as the hotel panel lists it. */
export interface HotelTaskDto {
  id: string
  kind: HotelTaskKind
  status: HotelTaskStatus
  roomId: string
  roomNumber: string
  bookingId: string | null
  quantity: number
  dueDate: string
  doneAt: string | null
}

/** The most tasks one list returns (a busy hotel's open work fits many times over). */
const TASK_LIST_LIMIT = 500

const toTaskDto = ({ task, roomNumber }: HotelTaskListRow): HotelTaskDto => ({
  id: task.id,
  kind: task.kind as HotelTaskKind,
  status: task.status as HotelTaskStatus,
  roomId: task.roomId,
  roomNumber,
  bookingId: task.bookingId,
  quantity: task.quantity,
  dueDate: task.dueDate,
  doneAt: task.doneAt?.toISOString() ?? null,
})

/** v7 §11, at confirmation (inside its transaction): the booking's extra beds become set-up and removal tasks. */
export async function planExtraBedTasks(tx: Db, scope: OrganizationScope, booking: BookingRow): Promise<void> {
  const repos = bookingOrgRepos(tx, scope)
  const { rooms } = await repos.records.details(booking.id)
  const planned = extraBedTasks(rooms)
  await repos.hotelTasks.insertMany(planned.map(t => ({ ...t, hotelId: booking.hotelId, bookingId: booking.id })))
}

/** The hotel's housekeeping work (`booking.view` on the hotel): open tasks by default, the soonest due first. */
export async function listHotelTasks(ctx: AuthContext, hotelId: string, query: HotelTaskQuery): Promise<HotelTaskDto[]> {
  await authorizeHotel(ctx, 'booking.view', hotelId, { allowInactive: true })
  const rows = await bookingOrgRepos(ctx.db, ctx.scope).hotelTasks.list({ hotelId, ...query, limit: TASK_LIST_LIMIT })
  return rows.map(toTaskDto)
}

/**
 * Marks a task done (`booking.checkIn` on the hotel: reception; a write, so not on an inactive hotel). Done again
 * answers it unchanged; a cancelled task is 409.
 */
export async function completeHotelTask(ctx: AuthContext, hotelId: string, taskId: string): Promise<HotelTaskDto> {
  await authorizeHotel(ctx, 'booking.checkIn', hotelId)
  const repos = bookingOrgRepos(ctx.db, ctx.scope).hotelTasks
  await repos.markDone(taskId, hotelId, { by: ctx.identity.userId, at: ctx.now() })
  const current = await repos.findById(taskId, hotelId)
  if (!current) throw new NotFoundError('TASK_NOT_FOUND')
  if (current.task.status === 'CANCELLED') throw new ConflictError('TASK_CANCELLED', 'This task was cancelled')
  return toTaskDto(current)
}
