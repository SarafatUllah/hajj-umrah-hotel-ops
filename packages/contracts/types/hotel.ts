/** The hotels API's response shapes (Phase 1 tasks 12–14, 19; UI-UX-MASTER-DIRECTION §42 S2–S4). */
import type { DocType } from '../constants/documents'
import type { HotelStatus, OwnershipType } from '../constants/inventory'
import type { IsoDate } from '../utils/dates'

/** What the public site shows of a hotel (nothing internal: no code, settings, counts or contact data). */
export interface PublicHotel { id: string, name: string, city: string, country: string, address: string | null }

/**
 * A hotel as the switcher and the hotels list show it (S2): `today` is the hotel-local date. `floorCount` (active
 * floors) and `roomCount` (rooms in inventory today) are filled by the list and detail reads only, and are `null`
 * for a caller without `room.view` (the list reveals no inventory to them).
 */
export interface HotelSummary {
  id: string
  code: string
  name: string
  city: string
  country: string
  status: HotelStatus
  timezone: string
  today: IsoDate
  floorCount: number | null
  roomCount: number | null
}

export interface HotelDetail extends HotelSummary {
  address: string | null
  phone: string | null
  email: string | null
  currency: string
  checkInTime: string
  checkOutTime: string
  ownershipType: OwnershipType
  licenseReference: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

/** One entry of a hotel's history (S3), newest first; the actor's name is joined within the organization only. */
export interface AuditItemDto {
  id: string
  action: string
  entityType: string
  entityId: string
  actor: { id: string, fullName: string } | null
  before: unknown
  after: unknown
  reason: string | null
  createdAt: string
}

/** A page of history; `nextCursor` asks for older entries (`null`: none left). */
export interface AuditPageDto {
  items: AuditItemDto[]
  nextCursor: string | null
}

/** A hotel document. The storage key is deliberately absent: it never leaves the server. */
export interface DocumentDto {
  id: string
  docType: DocType
  title: string
  description: string | null
  /** Sanitized display name — never a path. */
  originalFilename: string
  mimeType: string
  sizeBytes: number
  sha256: string
  uploadedBy: string | null
  createdAt: string
  archivedAt: string | null
}

export interface DocumentPage { items: DocumentDto[], page: number, pageSize: number, total: number }

export interface FloorListItem {
  id: string
  level: number
  label: string
  isActive: boolean
  /** Rooms in inventory (a base-config version covering the hotel's own local today) on this floor. */
  roomCount: number
}

/**
 * A room type of the organization's catalog (S4). `usageCount` counts the organization's rooms in inventory today; it
 * is filled for a caller who sees every hotel, and `null` for anyone else — a hotel's own staff would otherwise learn
 * room counts of hotels they cannot see.
 */
export interface RoomTypeListItem {
  id: string
  code: string
  name: string
  defaultPhysicalBeds: number
  defaultSellableCapacity: number
  description: string | null
  sortOrder: number
  isActive: boolean
  usageCount: number | null
}
