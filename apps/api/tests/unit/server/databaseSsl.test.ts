import { describe, expect, it } from 'vitest'
import { databaseSsl } from '@hajj/db/ssl'

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----'

describe('databaseSsl (DATABASE_SSL, DATABASE_SSL_CA)', () => {
  it('is off by default and when off: a plain connection (a local database)', () => {
    expect(databaseSsl({})).toBe(false)
    expect(databaseSsl({ DATABASE_SSL: 'off' })).toBe(false)
  })

  it('require: encrypted, the server certificate not checked', () => {
    expect(databaseSsl({ DATABASE_SSL: 'require' })).toEqual({ rejectUnauthorized: false })
  })

  it('verify: encrypted and checked, against the given CA or the system ones', () => {
    expect(databaseSsl({ DATABASE_SSL: 'verify', DATABASE_SSL_CA: PEM })).toEqual({ rejectUnauthorized: true, ca: PEM })
    expect(databaseSsl({ DATABASE_SSL: 'verify' })).toEqual({ rejectUnauthorized: true })
  })

  it('reads a CA pasted on one line with \\n escapes as the multi-line certificate it is', () => {
    expect(databaseSsl({ DATABASE_SSL: 'verify', DATABASE_SSL_CA: PEM.replaceAll('\n', '\\n') })).toEqual({ rejectUnauthorized: true, ca: PEM })
  })

  it.each(['true', 'REQUIRE', 'verify-full', 'disable'])('refuses DATABASE_SSL=%j instead of guessing', (value) => {
    expect(() => databaseSsl({ DATABASE_SSL: value })).toThrow(/DATABASE_SSL must be off, require or verify/)
  })
})
