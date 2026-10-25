import { resolveSettings } from '@hajj/contracts/business-rules/hotelSettings'
import type { CalendarOptions } from '../domain/inventory/calendar'
import type { hotelRepos } from '../repositories'

/**
 * The hotel's calendar options, read through the same `hotel_setting` mechanism as `hotelService`'s
 * settings (stored rows + registry defaults via `resolveSettings`) — ONE query. `maintenanceBlocksSales`
 * only changes whether a MAINTENANCE night is SELLABLE, never the displayed `status`, and never what is
 * stored. Shared by the room, calendar, averages and booking-conflict paths.
 */
export async function calendarOptionsFor(hotelScoped: ReturnType<typeof hotelRepos>): Promise<CalendarOptions> {
  const rows = await hotelScoped.settings.getAll()
  const stored: Record<string, unknown> = {}
  for (const row of rows) stored[row.key] = row.value
  return { maintenanceBlocksSales: resolveSettings(stored)['inventory.maintenanceBlocksSales'] }
}
