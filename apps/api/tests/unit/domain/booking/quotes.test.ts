import { describe, expect, it } from 'vitest'
import { DEFAULT_QUOTE_TEMPLATE, effectiveQuoteStatus, quoteMessage, quoteRefNo, whatsappLink } from '../../../../server/domain/booking/quotes'

const facts = { refNo: 'Q-2027-0142', agencyName: 'Al-Noor Travels', hotelCode: 'MKK-GRAND', hotelName: 'Grand', checkIn: '2027-06-01', checkOut: '2027-06-10', bookingType: 'GROUP' as const, maleCount: 18, femaleCount: 12, totalCount: 30 }

describe('quotes', () => {
  it('reference numbers are Q-<year>-<4+ digits>', () => {
    expect(quoteRefNo(2027, 142)).toBe('Q-2027-0142')
    expect(quoteRefNo(2027, 12345)).toBe('Q-2027-12345')
  })

  it('an OFFERED quote past its validity is EXPIRED; other statuses are as stored', () => {
    const now = new Date('2027-05-01T12:00:00Z')
    expect(effectiveQuoteStatus({ status: 'OFFERED', validUntil: new Date('2027-05-01T12:00:00Z') }, now)).toBe('EXPIRED')
    expect(effectiveQuoteStatus({ status: 'OFFERED', validUntil: new Date('2027-05-01T12:00:01Z') }, now)).toBe('OFFERED')
    expect(effectiveQuoteStatus({ status: 'ACCEPTED', validUntil: new Date('2027-04-01T00:00:00Z') }, now)).toBe('ACCEPTED')
  })

  it('the default message names the reference, agency, hotel, stay and head count (v7 §8)', () => {
    expect(quoteMessage(facts)).toBe([
      'Assalamu alaikum. Price request: Q-2027-0142',
      'Agency: Al-Noor Travels',
      'Hotel: MKK-GRAND Grand · 2027-06-01 – 2027-06-10 (9 nights)',
      'Type: Group · men 18, women 12 (total 30)',
    ].join('\n'))
    expect(DEFAULT_QUOTE_TEMPLATE).toContain('{ref}')
  })

  it('a custom template fills known placeholders and keeps unknown ones', () => {
    expect(quoteMessage({ ...facts, bookingType: 'FAMILY', maleCount: 0, femaleCount: 0, totalCount: 5 }, '{ref} {type} {counts} {unknown}')).toBe('Q-2027-0142 Family 5 persons {unknown}')
  })

  it('only the message\'s own placeholders are filled: inherited object keys stay as written', () => {
    expect(quoteMessage(facts, '{constructor} {toString} {__proto__} {ref}')).toBe('{constructor} {toString} {__proto__} Q-2027-0142')
  })

  it('builds a wa.me link with the text URL-encoded', () => {
    expect(whatsappLink('966512345678', 'Price request: Q-1\nLine 2')).toBe('https://wa.me/966512345678?text=Price%20request%3A%20Q-1%0ALine%202')
  })
})
