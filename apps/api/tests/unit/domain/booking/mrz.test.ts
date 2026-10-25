import { describe, expect, it } from 'vitest'
import { findMrzLines, parseMrz } from '../../../../server/domain/booking/mrz'
import { fromMrz, mergeReadings, pickSlot } from '../../../../server/domain/booking/passportScan'
import { td3 } from '../../../support/mrz'

// ICAO Doc 9303 specimen (TD3).
const SPECIMEN: [string, string] = ['P<UTOERIKSSON<<ANNA<MARIA'.padEnd(44, '<'), 'L898902C36UTO7408122F1204159ZE184226B<<<<<10']

describe('MRZ (ICAO 9303 TD3)', () => {
  it('reads the specimen with every check digit verified', () => {
    const reading = parseMrz(SPECIMEN, '2027-06-01')!
    expect(reading.fields).toEqual({ issuingState: 'UTO', surname: 'ERIKSSON', givenNames: 'ANNA MARIA', passportNo: 'L898902C3', nationality: 'UTO', dateOfBirth: '1974-08-12', sex: 'FEMALE', passportExpiry: '2012-04-15' })
    expect(reading.checks).toEqual({ passportNo: true, dateOfBirth: true, passportExpiry: true, composite: true })
  })

  it('repairs OCR letter/digit confusions by position, and flags a wrong check digit', () => {
    const noisy = SPECIMEN[1].replace('7408122', '74O8122').replace('UTO', 'UT0')
    expect(parseMrz([SPECIMEN[0], noisy], '2027-06-01')!.fields).toMatchObject({ dateOfBirth: '1974-08-12', nationality: 'UTO' })
    const wrong = `${SPECIMEN[1].slice(0, 9)}7${SPECIMEN[1].slice(10)}`
    expect(parseMrz([SPECIMEN[0], wrong], '2027-06-01')!.checks).toMatchObject({ passportNo: false, composite: false })
  })

  it('finds the two lines in OCR text (spaces dropped, « read as <); a birth year in the future belongs to the last century', () => {
    const text = `PASSPORT\nRepublic of Utopia\n${SPECIMEN[0].replace('ANNA<', 'ANNA«')}\n${SPECIMEN[1].slice(0, 9)} ${SPECIMEN[1].slice(9)}\n`
    expect(findMrzLines(text)).toEqual(SPECIMEN)
    expect(findMrzLines('no machine-readable zone here')).toBeNull()
    expect(parseMrz(td3('KARIM', 'MD', 'A1234567', 'BGD', '300101', 'M', '320101'), '2027-06-01')!.fields.dateOfBirth).toBe('1930-01-01')
  })

  it('as review fields: verified fields are trusted, a cut-off name is flagged', () => {
    const result = fromMrz(parseMrz(SPECIMEN, '2027-06-01')!)
    expect(result).toMatchObject({ method: 'MRZ', fields: { fullName: 'ANNA MARIA ERIKSSON', gender: 'FEMALE', passportNo: 'L898902C3' }, confidence: { passportNo: 0.99, fullName: 0.8 } })
    const longName = `P<UTO${'X'.repeat(39)}`
    expect(fromMrz(parseMrz([longName, SPECIMEN[1]], '2027-06-01')!).confidence.fullName).toBe(0.4)
  })

  it('the AI fills only what the MRZ lacks or read poorly', () => {
    const mrz = { method: 'MRZ' as const, fields: { passportNo: 'A1', fullName: 'MD KARIM' }, confidence: { passportNo: 0.99, fullName: 0.4 } }
    const ai = { method: 'AI' as const, fields: { passportNo: 'B2', fullName: 'Md. Karim Uddin', placeOfBirth: 'Dhaka' }, confidence: { passportNo: 0.6, fullName: 0.6, placeOfBirth: 0.6 } }
    expect(mergeReadings(mrz, ai)).toEqual({ method: 'MRZ', fields: { passportNo: 'A1', fullName: 'Md. Karim Uddin', placeOfBirth: 'Dhaka' }, confidence: { passportNo: 0.99, fullName: 0.6, placeOfBirth: 0.6 } })
    expect(mergeReadings(null, ai)).toBe(ai)
    expect(mergeReadings(null, null)).toBeNull()
  })
})

describe('pickSlot (v7 §13 step 3)', () => {
  const stay = { bookingType: 'GROUP' as const, checkIn: '2027-06-01' }
  const limits = { childAgeLimit: 10, infantAgeLimit: 2 }
  const slots = [
    { id: 'm1', slotNo: 1, ageGroup: 'ADULT' as const, occupancy: 'MALE' as const },
    { id: 'f1', slotNo: 3, ageGroup: 'ADULT' as const, occupancy: 'FEMALE' as const },
    { id: 'c1', slotNo: 4, ageGroup: 'CHILD' as const, occupancy: 'FEMALE' as const },
    { id: 'i1', slotNo: 5, ageGroup: 'INFANT' as const, occupancy: 'FEMALE' as const },
  ]

  it('a GROUP adult goes to the side of the passport\'s gender; children and infants to their own slots', () => {
    expect(pickSlot({ gender: 'FEMALE', dateOfBirth: '1980-01-01' }, slots, stay, limits)).toBe('f1')
    expect(pickSlot({ gender: 'MALE', dateOfBirth: '2019-01-01' }, slots, stay, limits)).toBe('c1')
    expect(pickSlot({ gender: 'MALE', dateOfBirth: '2026-01-01' }, slots, stay, limits)).toBe('i1')
    expect(pickSlot({ dateOfBirth: '1980-01-01' }, slots, stay, limits)).toBeNull()
    expect(pickSlot({ gender: 'MALE' }, slots.slice(1), stay, limits)).toBeNull()
  })

  it('a FAMILY takes the first seated slot', () => {
    expect(pickSlot({ gender: 'FEMALE', dateOfBirth: '1980-01-01' }, slots, { ...stay, bookingType: 'FAMILY' }, limits)).toBe('m1')
  })
})
