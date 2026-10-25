import { describe, expect, it } from 'vitest'
import { quoteOfferSchema } from '@hajj/contracts/schemas/quote'

const OFFER = { amountHalalas: 35000, unit: 'PER_PERSON_NIGHT', vatIncluded: true }

describe('a quote offer (v7 §8)', () => {
  it('is a price: never nothing, never free', () => {
    expect(quoteOfferSchema.safeParse(OFFER).success).toBe(true)
    expect(quoteOfferSchema.safeParse({ ...OFFER, amountHalalas: 1 }).success).toBe(true)
    expect(quoteOfferSchema.safeParse({ ...OFFER, amountHalalas: 0 }).success).toBe(false)
    expect(quoteOfferSchema.safeParse({ ...OFFER, amountHalalas: undefined }).success).toBe(false)
  })

  it('holds for 1 to 720 hours, or the booking setting when left out', () => {
    expect(quoteOfferSchema.parse(OFFER).validHours).toBeUndefined()
    expect(quoteOfferSchema.safeParse({ ...OFFER, validHours: 720 }).success).toBe(true)
    expect(quoteOfferSchema.safeParse({ ...OFFER, validHours: 0 }).success).toBe(false)
    expect(quoteOfferSchema.safeParse({ ...OFFER, validHours: 721 }).success).toBe(false)
  })
})
