import { describe, expect, it } from 'vitest'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { homeOf, linkOf, NAVIGATION, type NavItem, visibleNavigation } from '../app/utils/nav'

const accessWith = (...permissions: Permission[]) => ({ can: (p: Permission) => permissions.includes(p) })

describe('the navigation (§2.2, §6.2)', () => {
  it('shows an item only with its read permission, a group only with an item, demo data only in the demo', () => {
    const hr = visibleNavigation(NAVIGATION, accessWith('hotel.view'), false)
    expect(hr.flatMap(g => g.items.map(i => i.key))).toEqual(['hotels'])
    const accountant = visibleNavigation(NAVIGATION, accessWith('hotel.view', 'booking.view'), false)
    expect(accountant.flatMap(g => g.items.map(i => i.key))).toEqual(['hotels', 'bookings', 'tasks', 'quotes'])
    const reception = visibleNavigation(NAVIGATION, accessWith('hotel.view', 'room.view', 'booking.view', 'booking.checkIn', 'occupancy.view'), true)
    expect(reception.flatMap(g => g.items.map(i => i.key))).toEqual(['overview', 'hotels', 'calendar', 'rooms', 'seasons', 'blocks', 'roomTypes', 'bookings', 'frontDesk', 'occupancy', 'tasks', 'quotes'])

    const admin = visibleNavigation(NAVIGATION, accessWith('hotel.view', 'room.view', 'organization.resetDemo'), true)
    expect(admin.map(g => g.key)).toContain('admin')
    expect(visibleNavigation(NAVIGATION, accessWith('hotel.view', 'room.view', 'organization.resetDemo'), false).map(g => g.key)).not.toContain('admin')
  })

  it('a hotel page opens for the last hotel used, else through the hotel chooser', () => {
    const rooms: NavItem = { key: 'rooms', icon: 'i-lucide-door-closed', scope: 'hotel', path: 'rooms', permission: 'room.view' }
    expect(linkOf(rooms, 'MKK-GRAND')).toBe('/hotels/MKK-GRAND/rooms')
    expect(linkOf(rooms, null)).toBe('/select-hotel?next=rooms')
    const hotels = NAVIGATION.flatMap(g => g.items).find(i => i.key === 'hotels')!
    expect(linkOf(hotels, 'MKK-GRAND')).toBe('/hotels')
  })

  it('a staff member starts on the Overview when they see inventory, else on the bookings, else on the hotels list', () => {
    expect(homeOf(accessWith('hotel.view', 'room.view', 'booking.view'))).toBe('/overview')
    expect(homeOf(accessWith('hotel.view', 'booking.view'))).toBe('/bookings')
    expect(homeOf(accessWith('hotel.view'))).toBe('/hotels')
  })
})
