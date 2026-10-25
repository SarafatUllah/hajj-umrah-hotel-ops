import { describe, expect, it } from 'vitest'
import { agencyProfileRequest, emptyAgencyProfile } from '../app/utils/agency'

describe('an agency profile as the API takes it', () => {
  it('leaves the empty optional fields out and keeps the rest', () => {
    const values = { ...emptyAgencyProfile(), name: 'Al-Noor', whatsappNumber: '', address: 'Dhaka' }
    expect(agencyProfileRequest(values)).toEqual({ ...values, whatsappNumber: undefined, address: 'Dhaka' })
  })
})
