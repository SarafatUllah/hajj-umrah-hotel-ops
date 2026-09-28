import type { DbOrTx } from '../../db/client'
import type { HotelScope, OrganizationScope } from '../security/scope'
import { HotelSettingRepository } from './hotel'
import { PlatformOrganizationRepository } from './platform/organizationRepository'
import { PlatformPermissionCatalogRepository } from './platform/permissionCatalogRepository'
import { AuditRepository, HotelRepository, RoleRepository, UserHotelAccessRepository, UserRepository } from './tenant'

export type * from './tenant'
export type * from './hotel'
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
  })
}

/** Hotel-scoped repositories: every statement is confined to `scope.organizationId` AND `scope.hotelId`. */
export function hotelRepos(db: DbOrTx, scope: HotelScope) {
  return lazy({
    settings: () => new HotelSettingRepository(db, scope),
  })
}

export type PlatformRepos = ReturnType<typeof platformRepos>
export type TenantRepos = ReturnType<typeof tenantRepos>
export type HotelRepos = ReturnType<typeof hotelRepos>
