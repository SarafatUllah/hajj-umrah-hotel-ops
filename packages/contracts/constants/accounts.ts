/** Agency account lifecycle (v7 §15 "এজেন্সি অনুমোদন"): only an APPROVED agency gets agency prices, quotes and bookings. */
export const AGENCY_STATUSES = ['PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED'] as const
export type AgencyStatus = typeof AGENCY_STATUSES[number]
