import type { PriceType, PriceUnit } from '@hajj/contracts/constants/pricing'
import type { AgencyQuotaInput, AllocationRuleInput, BookingRuleKind, ExtraBedPolicyInput, RateInput } from '@hajj/contracts/schemas/bookingRules'
import type { AgencyQuotaDto, AllocationRuleDto, ExtraBedPolicyDto, RateDto } from '@hajj/contracts/types/bookingRules'
import { toRiyals } from '@hajj/contracts/utils/money'
import { typedHalalas, typedNumber } from './forms'

/**
 * A hotel's booking rules as their forms hold them (v7 §15): money typed in riyals, a cleared number as nothing typed,
 * and a quota's agency as a choice — every agency (the default) is its own choice, never an empty one.
 */
export const EVERY_AGENCY = 'EVERY_AGENCY'

export interface RateForm { roomTypeId: string, priceType: PriceType, unit: PriceUnit, startDate: string, endDate: string, riyals: number | null | undefined, vatIncluded: boolean }
export function rateFormOf(rate: RateDto | null, today: string): RateForm {
  if (!rate) return { roomTypeId: '', priceType: 'PUBLIC', unit: 'PER_PERSON_NIGHT', startDate: today, endDate: '', riyals: undefined, vatIncluded: true }
  return { roomTypeId: rate.roomTypeId, priceType: rate.priceType, unit: rate.unit, startDate: rate.startDate, endDate: rate.endDate, riyals: toRiyals(rate.amountHalalas), vatIncluded: rate.vatIncluded }
}
export function rateRequestOf(form: RateForm): Partial<RateInput> {
  const { riyals, ...rest } = form
  return { ...rest, amountHalalas: typedHalalas(riyals) }
}

export interface QuotaForm { agency: string, startDate: string, endDate: string, maxPersons: number | null | undefined }
export function quotaFormOf(quota: AgencyQuotaDto | null, today: string): QuotaForm {
  if (!quota) return { agency: EVERY_AGENCY, startDate: today, endDate: '', maxPersons: undefined }
  return { agency: quota.agencyId ?? EVERY_AGENCY, startDate: quota.startDate, endDate: quota.endDate, maxPersons: quota.maxPersons }
}
export function quotaRequestOf(form: QuotaForm): Partial<AgencyQuotaInput> {
  return { agencyId: form.agency === EVERY_AGENCY ? null : form.agency, startDate: form.startDate, endDate: form.endDate, maxPersons: typedNumber(form.maxPersons) }
}

export interface RoomMixForm { groupMin: number | null | undefined, groupMax: number | null | undefined, minSeats: number | null | undefined, maxRooms: number | null | undefined }
export function roomMixFormOf(rule: AllocationRuleDto | null): RoomMixForm {
  if (!rule) return { groupMin: undefined, groupMax: undefined, minSeats: 5, maxRooms: undefined }
  return { groupMin: rule.groupMin, groupMax: rule.groupMax, minSeats: rule.minSeats, maxRooms: rule.maxRooms }
}
/** An empty "up to" is no upper bound (`null`), not a missing field. */
export function roomMixRequestOf(form: RoomMixForm): Partial<AllocationRuleInput> {
  return { groupMin: typedNumber(form.groupMin), groupMax: typedNumber(form.groupMax) ?? null, minSeats: typedNumber(form.minSeats), maxRooms: typedNumber(form.maxRooms) }
}

export interface ExtraBedForm { roomTypeId: string, maxPerRoom: number | null | undefined, maxPerBooking: number | null | undefined, riyals: number | null | undefined, vatIncluded: boolean, allowInOverrideSeason: boolean }
export function extraBedFormOf(policy: ExtraBedPolicyDto | null): ExtraBedForm {
  if (!policy) return { roomTypeId: '', maxPerRoom: 1, maxPerBooking: undefined, riyals: undefined, vatIncluded: true, allowInOverrideSeason: false }
  return { roomTypeId: policy.roomTypeId, maxPerRoom: policy.maxPerRoom, maxPerBooking: policy.maxPerBooking, riyals: toRiyals(policy.amountHalalas), vatIncluded: policy.vatIncluded, allowInOverrideSeason: policy.allowInOverrideSeason }
}
export function extraBedRequestOf(form: ExtraBedForm): Partial<ExtraBedPolicyInput> {
  return { roomTypeId: form.roomTypeId, maxPerRoom: typedNumber(form.maxPerRoom), maxPerBooking: typedNumber(form.maxPerBooking), amountHalalas: typedHalalas(form.riyals), vatIncluded: form.vatIncluded, allowInOverrideSeason: form.allowInOverrideSeason }
}

/** Each rule kind's strings (`rules.<section>.*`). */
export const RULE_SECTIONS: Record<BookingRuleKind, string> = { 'rates': 'rates', 'agency-quotas': 'quotas', 'allocation-rules': 'roomMix', 'extra-bed-policies': 'extraBeds' }

/** Why a save was refused when another rule already covers it (409): said for the rule's own kind. */
export function ruleConflictKey(kind: BookingRuleKind, code: string): string | null {
  if (code === 'RANGE_OVERLAP') return `rules.${RULE_SECTIONS[kind]}.overlap`
  if (code === 'ALREADY_EXISTS') return `rules.${RULE_SECTIONS[kind]}.exists`
  return null
}

/** Rates in reading order: by room type (as `typeName` names it), public before the agency default, per person first, then by season. */
export function sortedRates(rates: readonly RateDto[], typeName: (id: string) => string): RateDto[] {
  const rank = (rate: RateDto) => [typeName(rate.roomTypeId), rate.priceType === 'PUBLIC' ? 0 : 1, rate.unit === 'PER_PERSON_NIGHT' ? 0 : 1, rate.startDate] as const
  return [...rates].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)]
    return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2] - y[2] || x[3].localeCompare(y[3])
  })
}

/** Quotas in reading order: the default for every agency first, then by agency (as `agencyName` names it), then by season. */
export function sortedQuotas(quotas: readonly AgencyQuotaDto[], agencyName: (quota: AgencyQuotaDto) => string): AgencyQuotaDto[] {
  return [...quotas].sort((a, b) => Number(a.agencyId !== null) - Number(b.agencyId !== null)
    || agencyName(a).localeCompare(agencyName(b))
    || a.startDate.localeCompare(b.startDate))
}
