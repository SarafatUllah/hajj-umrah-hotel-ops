import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../../../server/utils/password'

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('wrong password', hash)).toBe(false)
  })

  it('produces different hashes for the same password due to random salt', async () => {
    const hash1 = await hashPassword('same password')
    const hash2 = await hashPassword('same password')
    expect(hash1).not.toBe(hash2)
    expect(await verifyPassword('same password', hash1)).toBe(true)
    expect(await verifyPassword('same password', hash2)).toBe(true)
  })

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-valid-hash')).toBe(false)
  })

  it('produces a PHC-formatted Argon2id hash', async () => {
    const hash = await hashPassword('some password')
    expect(hash).toMatch(/^\$argon2id\$/)
  })
})
