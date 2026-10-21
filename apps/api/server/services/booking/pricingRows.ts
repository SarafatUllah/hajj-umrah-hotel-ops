import type { PriceType, PriceUnit } from '@hajj/contracts/constants/pricing'
import type { RateRule } from '../../domain/booking/pricing'
import type { RateRepository } from '../../repositories/booking'

type RateRow = Awaited<ReturnType<RateRepository['list']>>[number]

/** A stored rate as the pricing domain reads it (text columns narrowed to their checked value sets). */
export function toRateRule(row: RateRow): RateRule {
  return { roomTypeId: row.roomTypeId, priceType: row.priceType as PriceType, unit: row.unit as PriceUnit, startDate: row.startDate, endDate: row.endDate, amountHalalas: row.amountHalalas, vatIncluded: row.vatIncluded }
}
