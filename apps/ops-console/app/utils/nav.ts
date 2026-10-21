import type { Permission } from '@hajj/contracts/constants/permissions'

/**
 * Where an item lives (§6.1): an organization page, a portfolio page (optionally one hotel by `?hotel=`), or a
 * hotel's page (`/hotels/:code/<path>`).
 */
export type NavScope = 'organization' | 'portfolio' | 'hotel'

export interface NavItem {
  key: string
  icon: string
  scope: NavScope
  /** The route (organization, portfolio) or the hotel sub-page (hotel scope). */
  path: string
  /** Shown only with this permission (the module's read permission). */
  permission: Permission
  demoOnly?: boolean
}

export interface NavGroup { key: string, items: NavItem[] }

/**
 * The console's navigation (§2.1): only modules that exist are listed — a module joins by adding its item here.
 * Labels are `nav.<key>` (items) and `nav.group.<key>` (groups).
 */
export const NAVIGATION: NavGroup[] = [
  { key: 'main', items: [
    { key: 'overview', icon: 'i-lucide-layout-dashboard', scope: 'portfolio', path: '/overview', permission: 'room.view' },
    { key: 'hotels', icon: 'i-lucide-building-2', scope: 'organization', path: '/hotels', permission: 'hotel.view' },
  ] },
  { key: 'inventory', items: [
    { key: 'roomTypes', icon: 'i-lucide-bed-double', scope: 'organization', path: '/room-types', permission: 'room.view' },
  ] },
  { key: 'admin', items: [
    { key: 'demo', icon: 'i-lucide-flask-conical', scope: 'organization', path: '/admin/demo', permission: 'organization.resetDemo', demoOnly: true },
  ] },
]

/** The groups and items this user sees (§2.2): a group only when one of its items shows. */
export function visibleNavigation(groups: NavGroup[], access: { can: (permission: Permission) => boolean }, isDemo: boolean): NavGroup[] {
  return groups
    .map(group => ({ ...group, items: group.items.filter(item => access.can(item.permission) && (!item.demoOnly || isDemo)) }))
    .filter(group => group.items.length > 0)
}

/**
 * Where a staff member starts (§35.2): the Overview for anyone who sees inventory, else the hotels list (Accountant,
 * HR: their modules come in later phases).
 */
export function homeOf(access: { can: (permission: Permission) => boolean }): string {
  return access.can('room.view') ? '/overview' : '/hotels'
}

/** An item's link: a hotel page opens for the last hotel used, else the hotel chooser asks which (§6.2). */
export function linkOf(item: NavItem, lastHotelCode: string | null): string {
  if (item.scope !== 'hotel') return item.path
  return lastHotelCode ? `/hotels/${lastHotelCode}/${item.path}` : `/select-hotel?next=${item.path}`
}
