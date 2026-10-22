import { describe, expect, it } from 'vitest'
import { e164Phone } from '@hajj/contracts/schemas/common'
import { otpVerifySchema } from '@hajj/contracts/schemas/customer'
import { toLatinDigits } from '@hajj/contracts/utils/digits'

describe('Arabic keyboards type their own digits', () => {
  it('toLatinDigits maps Arabic-Indic and Persian digits, and leaves everything else', () => {
    expect(toLatinDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789')
    expect(toLatinDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789')
    expect(toLatinDigits('+٩٦٦ 5x-٧')).toBe('+966 5x-7')
  })

  it('a phone number and a sign-in code typed in Arabic digits are accepted as Latin ones', () => {
    expect(e164Phone.parse('+٩٦٦ ٥٥ ١٢٣ ٤٥٦٧')).toBe('+966551234567')
    const verify = { organizationSlug: 'demo', challengeId: '00000000-0000-4000-8000-000000000000' }
    expect(otpVerifySchema.parse({ ...verify, code: '٤٣٧٩٣٤' }).code).toBe('437934')
    expect(otpVerifySchema.safeParse({ ...verify, code: '٤٣٧٩' }).success).toBe(false)
  })
})
