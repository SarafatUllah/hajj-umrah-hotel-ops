/** Lower index = higher display precedence. Phase 2 slots OCCUPIED/BOOKED/HELD in without a schema change. */
export const INVENTORY_STATUSES = ['NOT_IN_INVENTORY', 'OUT_OF_SERVICE', 'MAINTENANCE', 'OPERATIONAL_BLOCK', 'OCCUPIED', 'BOOKED', 'HELD', 'AVAILABLE'] as const
export type InventoryStatus = typeof INVENTORY_STATUSES[number]

/** Operational block kinds, highest display precedence first. */
export const BLOCK_KINDS = ['OUT_OF_SERVICE', 'MAINTENANCE', 'OPERATIONAL_BLOCK'] as const
export type BlockKind = typeof BLOCK_KINDS[number]

export const CAPACITY_PERIOD_KINDS = ['HAJJ', 'RAMADAN', 'SPECIAL'] as const
export type CapacityPeriodKind = typeof CAPACITY_PERIOD_KINDS[number]

export const HOTEL_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export type HotelStatus = typeof HOTEL_STATUSES[number]
export const OWNERSHIP_TYPES = ['OWNED', 'LEASED', 'CONTRACTED'] as const
export type OwnershipType = typeof OWNERSHIP_TYPES[number]
export const BASE_CONFIG_ORIGINS = ['ROOM_TYPE_DEFAULT', 'MANUAL', 'BULK', 'SEED'] as const
export type BaseConfigOrigin = typeof BASE_CONFIG_ORIGINS[number]

/** Room feature tags (Task 14). */
export const ROOM_FEATURES = ['ACCESSIBLE', 'CONNECTING', 'CITY_VIEW', 'HARAM_VIEW'] as const
export type RoomFeature = typeof ROOM_FEATURES[number]

/** Hard limits that bound every list/range endpoint (DoS guards). */
export const MAX_CALENDAR_DAYS = 400
export const MAX_ROOMS_PER_PAGE = 200
export const MAX_BEDS_PER_ROOM = 30
export const MAX_CAPACITY_PERIOD_DAYS = 366
export const MAX_BULK_ROOMS = 200
/** Cap on a `roomIds` override selector, after de-duplication (S9, Task 15). */
export const MAX_OVERRIDE_SELECTOR_ROOMS = 1000
/** Longest stay (in nights) the Available-Stay Average accepts (Task 17). */
export const MAX_AVERAGE_STAY_NIGHTS = 90
/** Cap on `availableStay.eligibleRoomIds` when `includeRoomIds=true` (Task 17); `eligibleRoomCount` is always exact (capped exactly when the list is shorter than the count). */
export const MAX_ELIGIBLE_ROOM_IDS = 2000
/** Cap on an explicit `hotelIds` list for the organization averages (Task 17). */
export const MAX_AVERAGE_HOTEL_IDS = 200
