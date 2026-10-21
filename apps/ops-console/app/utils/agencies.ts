import type { AgencyStatus } from '@hajj/contracts/constants/accounts'

/** A staff decision on an agency (the status it moves to). */
export type AgencyDecision = Exclude<AgencyStatus, 'PENDING'>

/** Which decisions follow from which status (v7 §15: approval after a licence check) — the API's rule, mirrored to offer them. */
const DECISIONS: Record<AgencyStatus, readonly AgencyDecision[]> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['SUSPENDED'],
  SUSPENDED: ['APPROVED', 'REJECTED'],
  REJECTED: ['APPROVED'],
}
export const agencyDecisions = (status: AgencyStatus): readonly AgencyDecision[] => DECISIONS[status]
