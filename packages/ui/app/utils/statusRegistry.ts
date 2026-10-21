/** Nuxt UI's colour aliases, as the status tones use them (§8.3, §11: status is never shown by colour alone). */
export type StatusTone = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

/** How a status looks wherever it appears: tone, icon (Lucide) and badge variant; the label comes from `status.<domain>.<value>`. */
export interface StatusLook { tone: StatusTone, icon: string, variant: 'soft' | 'outline' | 'solid' }

/** `icon` empty: a status that stays quiet (available is the normal state, §11.6). */
const look = (tone: StatusTone, icon: string, variant: StatusLook['variant'] = 'soft'): StatusLook => ({ tone, icon: icon ? `i-lucide-${icon}` : '', variant })

/**
 * The one status registry (§19): the server sends a value, this decides its look. Green is for action and selection,
 * so a good state is `success`; red only for what needs action or stops a sale.
 */
export const STATUS_REGISTRY = {
  booking: {
    HELD: look('info', 'clock', 'outline'),
    REQUESTED: look('info', 'hourglass', 'outline'),
    CONFIRMED: look('primary', 'calendar-check'),
    IN_HOUSE: look('primary', 'user-round', 'solid'),
    COMPLETED: look('neutral', 'circle-check'),
    CANCELLED: look('neutral', 'circle-x'),
    EXPIRED: look('neutral', 'timer-off'),
  },
  guest: {
    PENDING_DETAILS: look('warning', 'file-pen'),
    READY: look('success', 'circle-check'),
    CHECKED_IN: look('primary', 'user-round-check', 'solid'),
    CHECKED_OUT: look('neutral', 'log-out'),
    NO_SHOW: look('warning', 'user-x'),
    REMOVED: look('neutral', 'user-minus'),
  },
  quote: {
    REQUESTED: look('info', 'hourglass', 'outline'),
    OFFERED: look('success', 'tag'),
    ACCEPTED: look('primary', 'circle-check'),
    EXPIRED: look('neutral', 'timer-off'),
    DECLINED: look('neutral', 'circle-x'),
  },
  hotel: {
    ACTIVE: look('success', 'circle-check'),
    INACTIVE: look('neutral', 'circle-pause'),
  },
  agency: {
    PENDING: look('warning', 'hourglass'),
    APPROVED: look('success', 'circle-check'),
    SUSPENDED: look('error', 'ban'),
    REJECTED: look('neutral', 'circle-x'),
  },
  scan: {
    QUEUED: look('info', 'clock', 'outline'),
    PROCESSING: look('info', 'loader'),
    NEEDS_REVIEW: look('warning', 'eye'),
    CONFIRMED: look('success', 'circle-check'),
    FAILED: look('error', 'triangle-alert'),
    DISCARDED: look('neutral', 'trash-2'),
  },
  // A room on a night (§19.1): available is quiet; only exceptions get colour. Also a block's kind.
  inventory: {
    AVAILABLE: look('neutral', '', 'outline'),
    OPERATIONAL_BLOCK: look('neutral', 'lock'),
    MAINTENANCE: look('warning', 'wrench'),
    OUT_OF_SERVICE: look('error', 'ban'),
    NOT_IN_INVENTORY: look('neutral', 'circle-dashed', 'outline'),
    HELD: look('info', 'clock', 'outline'),
    BOOKED: look('primary', 'calendar-check'),
    OCCUPIED: look('primary', 'user-round', 'solid'),
  },
  block: {
    UPCOMING: look('info', 'calendar-clock'),
    RUNNING: look('warning', 'play'),
    ENDED: look('neutral', 'history'),
    CANCELLED: look('neutral', 'circle-x'),
    ENDED_EARLY: look('neutral', 'square'),
  },
  // A season (§19.1): indigo is the season layer's own colour, used for nothing else.
  season: {
    FUTURE: look('secondary', 'calendar-clock'),
    ACTIVE: look('success', 'play'),
    ENDED: look('neutral', 'history'),
  },
  task: {
    OPEN: look('warning', 'circle-dot'),
    DONE: look('success', 'circle-check'),
    CANCELLED: look('neutral', 'circle-x'),
  },
} as const satisfies Record<string, Record<string, StatusLook>>

export type StatusDomain = keyof typeof STATUS_REGISTRY

const UNKNOWN: StatusLook = look('neutral', 'circle-help')

/** The look of a status (an unknown value — a newer server — reads neutral rather than failing). */
export function statusLook(domain: StatusDomain, value: string): StatusLook {
  return (STATUS_REGISTRY[domain] as Record<string, StatusLook>)[value] ?? UNKNOWN
}
