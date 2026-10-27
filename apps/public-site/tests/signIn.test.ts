import { describe, expect, it } from 'vitest'
import { codeRequestBody, isEmailAddress, ownDestination, SIGN_IN_METHODS } from '../app/utils/signIn'

describe('sign-in by e-mail or phone (D-P2-68)', () => {
  it('offers e-mail first, then the phone', () => {
    expect(SIGN_IN_METHODS).toEqual(['email', 'phone'])
  })

  it('asks for the code on the chosen destination only, with the bot check\'s token when there is one', () => {
    expect(codeRequestBody('demo', { method: 'email', value: '  Aisha@Example.com ' }, 'tok')).toEqual({ organizationSlug: 'demo', email: 'Aisha@Example.com', captchaToken: 'tok' })
    expect(codeRequestBody('demo', { method: 'phone', value: '+966 50 123 4567' }, null)).toEqual({ organizationSlug: 'demo', phone: '+966 50 123 4567' })
  })

  it('checks an address with the API\'s own schema before sending it', () => {
    for (const ok of ['aisha@example.com', ' Aisha.Rahman+hajj@Example.co.uk ']) expect(isEmailAddress(ok), ok).toBe(true)
    for (const bad of ['', 'aisha', 'aisha@', '@example.com', 'aisha@example', 'a b@example.com', `${'a'.repeat(250)}@example.com`]) expect(isEmailAddress(bad), bad).toBe(false)
  })

  it('a signed-in customer confirms on their own phone, else on their own address', () => {
    expect(ownDestination({ phone: '+966501234567', email: null })).toEqual({ method: 'phone', value: '+966501234567' })
    expect(ownDestination({ phone: null, email: 'aisha@example.com' })).toEqual({ method: 'email', value: 'aisha@example.com' })
    expect(ownDestination({ phone: null, email: null })).toBeUndefined()
  })
})
