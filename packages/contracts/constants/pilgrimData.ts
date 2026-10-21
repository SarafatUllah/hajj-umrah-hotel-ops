/** How a passport scan was read (v7 §13): on-server MRZ first, then OCR, an external AI vision model only as a fallback. */
export const PASSPORT_SCAN_METHODS = ['MRZ', 'OCR', 'AI'] as const
export type PassportScanMethod = typeof PASSPORT_SCAN_METHODS[number]

/** A scan is never saved as guest data until a person confirms the review form (v7 §13). */
export const PASSPORT_SCAN_STATUSES = ['QUEUED', 'PROCESSING', 'NEEDS_REVIEW', 'CONFIRMED', 'FAILED', 'DISCARDED'] as const
export type PassportScanStatus = typeof PASSPORT_SCAN_STATUSES[number]

/** Personal data whose every read is logged in `pii_access_log` (v7 §13 PDPL). */
export const PII_SUBJECT_TYPES = ['PILGRIM', 'BOOKING_GUEST_DETAIL', 'PASSPORT_SCAN'] as const
export type PiiSubjectType = typeof PII_SUBJECT_TYPES[number]

/** What a passport scan read (v7 §13 table): the review form's fields, printed-page extras included. Dates are YYYY-MM-DD. */
export interface PassportScanFields {
  fullName?: string
  gender?: 'MALE' | 'FEMALE'
  nationality?: string
  dateOfBirth?: string
  passportNo?: string
  passportExpiry?: string
  placeOfBirth?: string
  passportIssueDate?: string
  issuingAuthority?: string
  address?: string
}
