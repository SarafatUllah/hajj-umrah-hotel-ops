import { describe, expect, it } from 'vitest'
import { agencyDecisions } from '../app/utils/agencies'

describe("the decisions staff may take on an agency (v7 §15, the API's rules)", () => {
  it('approve or reject a pending one, suspend an approved one, approve or reject a suspended one, approve a rejected one', () => {
    expect(agencyDecisions('PENDING')).toEqual(['APPROVED', 'REJECTED'])
    expect(agencyDecisions('APPROVED')).toEqual(['SUSPENDED'])
    expect(agencyDecisions('SUSPENDED')).toEqual(['APPROVED', 'REJECTED'])
    expect(agencyDecisions('REJECTED')).toEqual(['APPROVED'])
  })
})
