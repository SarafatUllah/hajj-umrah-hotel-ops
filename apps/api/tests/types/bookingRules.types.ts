import type { agencyQuota, allocationRule, bookingSetting, extraBedPolicy, rate } from '@hajj/db/schema'
import type { AgencyQuotaDto, AllocationRuleDto, BookingSettingsDto, ExtraBedPolicyDto, RateDto } from '@hajj/contracts/types/bookingRules'

/**
 * Compile-only (`pnpm typecheck:types`): each booking rule's response type names exactly its table's columns, less
 * the tenancy and authorship ones the API leaves out (plus a quota's agency name) — a column added or renamed fails
 * here until the type follows.
 */
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Shown<T, Hidden extends string> = Exclude<keyof T, Hidden>
type RuleColumns<T> = Shown<T, 'organizationId' | 'hotelId' | 'createdBy'>

export const rateKeys: SameKeys<RuleColumns<typeof rate.$inferSelect>, keyof RateDto> = true
export const quotaKeys: SameKeys<RuleColumns<typeof agencyQuota.$inferSelect> | 'agencyName', keyof AgencyQuotaDto> = true
export const roomMixKeys: SameKeys<RuleColumns<typeof allocationRule.$inferSelect>, keyof AllocationRuleDto> = true
export const extraBedKeys: SameKeys<RuleColumns<typeof extraBedPolicy.$inferSelect>, keyof ExtraBedPolicyDto> = true
export const settingsKeys: SameKeys<Shown<typeof bookingSetting.$inferSelect, 'organizationId' | 'updatedBy'>, keyof BookingSettingsDto> = true
