import { describe, expect, it } from 'vitest'
import { agencyPasswordChangeSchema, agencyUserPasswordSchema } from '@hajj/contracts/schemas/agency'

describe('an agency user\'s password (D-P2-25b)', () => {
  it('a change needs the current password and a new one of at least 10 characters, different from it', () => {
    expect(agencyPasswordChangeSchema.safeParse({ currentPassword: 'old-password', newPassword: 'a-new-password' }).success).toBe(true)
    expect(agencyPasswordChangeSchema.safeParse({ currentPassword: '', newPassword: 'a-new-password' }).success).toBe(false)
    expect(agencyPasswordChangeSchema.safeParse({ currentPassword: 'old-password', newPassword: 'short' }).success).toBe(false)
    const same = agencyPasswordChangeSchema.safeParse({ currentPassword: 'same-password', newPassword: 'same-password' })
    expect(same.success).toBe(false)
    expect(same.error?.issues[0]?.path).toEqual(['newPassword'])
  })

  it('a reset by staff is just the new password, nothing else', () => {
    expect(agencyUserPasswordSchema.safeParse({ password: 'a-new-password' }).success).toBe(true)
    expect(agencyUserPasswordSchema.safeParse({ password: 'a-new-password', isActive: true }).success).toBe(false)
  })
})
