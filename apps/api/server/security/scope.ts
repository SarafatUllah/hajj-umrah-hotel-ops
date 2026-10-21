declare const orgBrand: unique symbol
declare const hotelBrand: unique symbol

/** Proof that a tenant has been established server-side. Cannot be built from request input without going through this module. */
export interface OrganizationScope { readonly [orgBrand]: true, readonly organizationId: string }
/** Proof that the caller was authorised for this hotel inside this organization. */
export interface HotelScope extends OrganizationScope { readonly [hotelBrand]: true, readonly hotelId: string }

/**
 * The only functions that mint scopes. Importing them is restricted (ESLint + a fitness test) to
 * server/security/**, db/seed/** and tests/** — request handlers and services obtain scopes from
 * requireAuthContext() / authorizeHotel(), never by constructing them.
 */
export function trustedOrganizationScope(organizationId: string): OrganizationScope {
  return { organizationId } as unknown as OrganizationScope
}
export function trustedHotelScope(org: OrganizationScope, hotelId: string): HotelScope {
  return { organizationId: org.organizationId, hotelId } as unknown as HotelScope
}

declare const agencyBrand: unique symbol

/** Proof that the caller is a signed-in, active user of THIS agency (agency portal). Minted only by server/security. */
export interface AgencyScope extends OrganizationScope { readonly [agencyBrand]: true, readonly agencyId: string }

export function trustedAgencyScope(org: OrganizationScope, agencyId: string): AgencyScope {
  return { organizationId: org.organizationId, agencyId } as unknown as AgencyScope
}

declare const customerBrand: unique symbol

/** Proof that the caller is this signed-in customer (public site). Minted only by server/security. */
export interface CustomerScope extends OrganizationScope { readonly [customerBrand]: true, readonly customerId: string }

export function trustedCustomerScope(org: OrganizationScope, customerId: string): CustomerScope {
  return { organizationId: org.organizationId, customerId } as unknown as CustomerScope
}
