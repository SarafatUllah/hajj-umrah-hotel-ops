/** The booking rules' response shapes (v7 §15): a hotel's prices, quotas, room-mix rules and extra beds, and the organization's booking settings. */
import type { ChildSide } from '../constants/booking'
import type { PriceType, PriceUnit } from '../constants/pricing'
import type { BookingRuleKind } from '../schemas/bookingRules'

interface StoredRule {
  id: string
  createdAt: string
  updatedAt: string
}

/** A public price, or the default price for every approved agency, of a room type over an inclusive season. */
export interface RateDto extends StoredRule {
  roomTypeId: string
  priceType: PriceType
  unit: PriceUnit
  startDate: string
  endDate: string
  amountHalalas: number
  vatIncluded: boolean
}

/** Persons per night an agency may hold in the hotel over a season; `agencyId: null` is the default for every agency. */
export interface AgencyQuotaDto extends StoredRule {
  agencyId: string | null
  /** The agency's name (null for the default): the quotas read who without an agency list. */
  agencyName: string | null
  startDate: string
  endDate: string
  maxPersons: number
}

/** For a group (each gender apart) of `groupMin` to `groupMax` (null: no upper bound): at most `maxRooms` rooms of `minSeats` or more seats. */
export interface AllocationRuleDto extends StoredRule {
  groupMin: number
  groupMax: number | null
  minSeats: number
  maxRooms: number
}

/** Extra beds in one room type: how many a room and a booking may get, the price, and whether a seasonally changed room may. */
export interface ExtraBedPolicyDto extends StoredRule {
  roomTypeId: string
  maxPerRoom: number
  maxPerBooking: number
  amountHalalas: number
  vatIncluded: boolean
  allowInOverrideSeason: boolean
}

/** Each rule kind's shape, by its URL segment. */
export interface BookingRuleDtos {
  'rates': RateDto
  'agency-quotas': AgencyQuotaDto
  'allocation-rules': AllocationRuleDto
  'extra-bed-policies': ExtraBedPolicyDto
}
export type BookingRuleDto<K extends BookingRuleKind = BookingRuleKind> = BookingRuleDtos[K]

/** The organization's booking settings (every one defaulted). */
export interface BookingSettingsDto {
  holdMinutes: number
  requestHours: number
  quoteValidityHours: number
  individualMaxRooms: number
  individualMaxOpenRequests: number
  childAgeLimit: number
  infantAgeLimit: number
  childDefaultSide: ChildSide
  passportMinValidityMonths: number
  detailsReminderDays: number
  passportImageRetentionMonths: number
  passportAiAllowed: boolean
  guestDataRetentionMonths: number
  noShowReleasesSeats: boolean
  whatsappNumber: string | null
  whatsappTemplate: string | null
  updatedAt: string
}
