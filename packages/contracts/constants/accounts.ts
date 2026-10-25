/** Agency account lifecycle (v7 §15 "এজেন্সি অনুমোদন"): only an APPROVED agency gets agency prices, quotes and bookings. */
export const AGENCY_STATUSES = ['PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED'] as const
export type AgencyStatus = typeof AGENCY_STATUSES[number]

/** Customer phone sign-in codes (v7 §21): six digits, valid five minutes, five tries. */
export const OTP_CODE_LENGTH = 6
export const OTP_TTL_SECONDS = 5 * 60
export const OTP_MAX_ATTEMPTS = 5
