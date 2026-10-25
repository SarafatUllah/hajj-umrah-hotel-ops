import type { AgencyStatus } from '@hajj/contracts/constants/accounts'

/** Licence numbers compare without case or surrounding spaces (`abc-1` and ` ABC-1` are one licence). */
export const normalizeLicenseNo = (licenseNo: string): string => licenseNo.trim().toUpperCase()

/** Which staff decisions are allowed from which status (v7 §15: approval after a licence check). */
const ALLOWED_TRANSITIONS: Record<AgencyStatus, readonly AgencyStatus[]> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['SUSPENDED'],
  SUSPENDED: ['APPROVED', 'REJECTED'],
  REJECTED: ['APPROVED'],
}

export function canChangeAgencyStatus(from: AgencyStatus, to: AgencyStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}
