import type { DbOrTx } from '@hajj/db/client'
import type { HotelScope, OrganizationScope } from '../security/scope'
import { AgencyRepository, AgencyUserRepository, CustomerRepository, OtpChallengeRepository } from './accounts'
import { AgencyQuotaRepository, AllocationRuleRepository, BookingInventoryRepository, BookingRecordRepository, BookingRepository, BookingSettingRepository, DocumentSequenceRepository, ExtraBedPolicyRepository, GuestRepository, HotelTaskRepository, OccupancyReadRepository, PassportScanRepository, PiiAccessLogRepository, PilgrimRepository, PriceQuoteRepository, RateRepository } from './booking'
import { CapacityPeriodRepository, FloorRepository, HotelDocumentRepository, HotelSettingRepository, InventoryReadRepository, OperationalBlockRepository, RoomBaseConfigRepository, RoomCapacityOverrideRepository, RoomRepository } from './hotel'
import { PlatformOrganizationRepository } from './platform/organizationRepository'
import { PlatformOtpChallengeRepository } from './platform/otpChallengeRepository'
import { PlatformPermissionCatalogRepository } from './platform/permissionCatalogRepository'
import { PlatformRateLimitRepository } from './platform/rateLimitRepository'
import { AuditRepository, DocumentAssetRepository, EventReceiptRepository, HotelRepository, RoleRepository, RoomTypeRepository, TenantOrganizationRepository, UserHotelAccessRepository, UserRepository } from './tenant'

export type * from './tenant'
export type * from './hotel'
export type * from './booking'
export type * from './accounts'
export type { OrganizationRow, NewOrganization } from './platform/organizationRepository'
export type { PermissionRow } from './platform/permissionCatalogRepository'

/** Each property is built on first access and then reused. */
function lazy<T extends Record<string, () => unknown>>(factories: T): { readonly [K in keyof T]: ReturnType<T[K]> } {
  const repos = {} as { [K in keyof T]: ReturnType<T[K]> }
  for (const key of Object.keys(factories) as Array<keyof T>) {
    let instance: ReturnType<T[typeof key]> | undefined
    Object.defineProperty(repos, key, {
      enumerable: true,
      get: () => (instance ??= factories[key]!() as ReturnType<T[typeof key]>),
    })
  }
  return repos
}

/** Unscoped repositories for the tenant root and global catalogs (allow-listed; see layering.test.ts). */
export function platformRepos(db: DbOrTx) {
  return lazy({
    organizations: () => new PlatformOrganizationRepository(db),
    permissionCatalog: () => new PlatformPermissionCatalogRepository(db),
    rateLimits: () => new PlatformRateLimitRepository(db),
    otpChallenges: () => new PlatformOtpChallengeRepository(db),
  })
}

/** Organization-scoped repositories: every statement is confined to `scope.organizationId`. */
export function tenantRepos(db: DbOrTx, scope: OrganizationScope) {
  return lazy({
    users: () => new UserRepository(db, scope),
    roles: () => new RoleRepository(db, scope),
    audit: () => new AuditRepository(db, scope),
    hotels: () => new HotelRepository(db, scope),
    userHotelAccess: () => new UserHotelAccessRepository(db, scope),
    organization: () => new TenantOrganizationRepository(db, scope),
    roomTypes: () => new RoomTypeRepository(db, scope),
    documentAssets: () => new DocumentAssetRepository(db, scope),
    eventReceipts: () => new EventReceiptRepository(db, scope),
  })
}

/** Hotel-scoped repositories: every statement is confined to `scope.organizationId` AND `scope.hotelId`. */
export function hotelRepos(db: DbOrTx, scope: HotelScope) {
  return lazy({
    settings: () => new HotelSettingRepository(db, scope),
    floors: () => new FloorRepository(db, scope),
    rooms: () => new RoomRepository(db, scope),
    roomBaseConfigs: () => new RoomBaseConfigRepository(db, scope),
    capacityPeriods: () => new CapacityPeriodRepository(db, scope),
    roomCapacityOverrides: () => new RoomCapacityOverrideRepository(db, scope),
    operationalBlocks: () => new OperationalBlockRepository(db, scope),
    inventoryRead: () => new InventoryReadRepository(db, scope),
    hotelDocuments: () => new HotelDocumentRepository(db, scope),
  })
}

/** Accounts-module repositories (agencies, agency users, customers, sign-in codes) for one organization; used by server/services/accounts and server/security. */
export function accountsRepos(db: DbOrTx, scope: OrganizationScope) {
  return lazy({
    agencies: () => new AgencyRepository(db, scope),
    agencyUsers: () => new AgencyUserRepository(db, scope),
    customers: () => new CustomerRepository(db, scope),
    otpChallenges: () => new OtpChallengeRepository(db, scope),
  })
}

/** Booking-module repositories for one hotel (organization_id AND hotel_id); used only inside server/services/booking. */
export function bookingRepos(db: DbOrTx, scope: HotelScope) {
  return lazy({
    inventory: () => new BookingInventoryRepository(db, scope),
    bookings: () => new BookingRepository(db, scope),
    rates: () => new RateRepository(db, scope),
    agencyQuotas: () => new AgencyQuotaRepository(db, scope),
    allocationRules: () => new AllocationRuleRepository(db, scope),
    extraBedPolicies: () => new ExtraBedPolicyRepository(db, scope),
    occupancy: () => new OccupancyReadRepository(db, scope),
  })
}

/** Booking-module repositories for organization-wide data (settings, quotes, reference numbers, booking records and the hold sweep); used only inside server/services/booking. */
export function bookingOrgRepos(db: DbOrTx, scope: OrganizationScope) {
  return lazy({
    settings: () => new BookingSettingRepository(db, scope),
    quotes: () => new PriceQuoteRepository(db, scope),
    sequences: () => new DocumentSequenceRepository(db, scope),
    records: () => new BookingRecordRepository(db, scope),
    guests: () => new GuestRepository(db, scope),
    pilgrims: () => new PilgrimRepository(db, scope),
    piiAccess: () => new PiiAccessLogRepository(db, scope),
    passportScans: () => new PassportScanRepository(db, scope),
    hotelTasks: () => new HotelTaskRepository(db, scope),
  })
}

export type PlatformRepos = ReturnType<typeof platformRepos>
export type TenantRepos = ReturnType<typeof tenantRepos>
export type HotelRepos = ReturnType<typeof hotelRepos>
export type BookingRepos = ReturnType<typeof bookingRepos>
export type AccountsRepos = ReturnType<typeof accountsRepos>
