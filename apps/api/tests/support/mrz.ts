import { checkDigit } from '../../server/domain/booking/mrz'

/** A TD3 passport MRZ with correct check digits, for reading tests: `[line1, line2]`. */
export function td3(surname: string, given: string, passportNo: string, nationality: string, birth: string, sex: 'M' | 'F', expiry: string): [string, string] {
  const num = passportNo.padEnd(9, '<')
  const optional = '<'.repeat(14)
  const parts = [num + checkDigit(num), birth + checkDigit(birth), expiry + checkDigit(expiry), optional + checkDigit(optional)] as const
  const line2 = `${parts[0]}${nationality}${parts[1]}${sex}${parts[2]}${parts[3]}${checkDigit(parts.join(''))}`
  return [`P<${nationality}${surname}<<${given.replace(/ /g, '<')}`.padEnd(44, '<'), line2]
}
