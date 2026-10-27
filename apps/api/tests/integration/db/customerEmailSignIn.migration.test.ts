import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDbWithClient } from '@hajj/db/client'
import { customer, otpChallenge } from '@hajj/db/schema'
import { extractPgError } from '../../../server/errors/dbErrors'
import { makeOrg } from '../../support/fixtures'
import { migrateAll, migrateThrough, withScratchDatabase } from '../support/migrationHarness'

const SCRATCH_DB = 'hajj_umrah_migrate_customer_email_test'
/** The last migration before 0022 (customer sign-in by e-mail). */
const BEFORE_EMAIL_SIGN_IN = 21

const constraintOf = async (statement: PromiseLike<unknown>) => extractPgError(await Promise.resolve(statement).then(() => null, (error: unknown) => error))?.constraint

// A scratch database replays the whole chain: well past the 5 s default under a full-suite run.
describe('migration 0022 (customer sign-in by e-mail)', { timeout: 60_000 }, () => {
  it('keeps every existing customer and code valid; contact e-mails are normalized, a malformed one cleared', async () => {
    await withScratchDatabase(SCRATCH_DB, async (url) => {
      await migrateThrough(url, BEFORE_EMAIL_SIGN_IN)
      const { db, close } = createDbWithClient(url, { max: 1 })
      try {
        // Arrange (raw SQL: the schema already names the new column): open phone accounts, one with a contact e-mail
        // typed in capitals, one with a malformed one, a closed account that kept an e-mail, and an open SMS code.
        const { scope } = await makeOrg(db)
        const org = scope.organizationId
        const [open, messy, plain, closed] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
        await db.execute(sql`insert into customer (id, organization_id, full_name, phone, phone_verified_at, email) values
          (${open}, ${org}, 'Aisha', '+966500000001', now(), '  Aisha@Example.COM '),
          (${messy}, ${org}, 'Omar', '+966500000002', null, 'not an address'),
          (${plain}, ${org}, 'Fatima', '+966500000003', now(), null)`)
        await db.execute(sql`insert into customer (id, organization_id, full_name, phone, email, is_active, closed_at) values (${closed}, ${org}, 'Closed account', null, 'Left@Example.com', false, now())`)
        await db.execute(sql`insert into otp_challenge (organization_id, phone, code_hash, expires_at) values (${org}, '+966500000001', ${'a'.repeat(64)}, now() + interval '5 minutes')`)

        // Act
        await migrateAll(url)

        // Assert: every row kept, none verified by the migration.
        const rows = new Map((await db.select().from(customer)).map(row => [row.id, row]))
        expect(rows.get(open)).toMatchObject({ phone: '+966500000001', email: 'aisha@example.com', emailVerifiedAt: null, closedAt: null })
        expect(rows.get(messy)).toMatchObject({ phone: '+966500000002', email: null })
        expect(rows.get(plain)).toMatchObject({ phone: '+966500000003', email: null })
        expect(rows.get(closed)).toMatchObject({ phone: null, email: null, isActive: false, closedAt: expect.any(Date) })
        expect(await db.select().from(otpChallenge)).toMatchObject([{ phone: '+966500000001', email: null }])

        // The new rules hold from now on: an open account needs a phone or a verified e-mail; a code goes to one of them.
        expect(await constraintOf(db.insert(customer).values({ organizationId: org, fullName: 'Nobody', email: 'nobody@example.com' }))).toBe('customer_closed_check')
        await db.insert(customer).values({ organizationId: org, fullName: 'By e-mail', email: 'mail@example.com', emailVerifiedAt: new Date() })
        expect(await constraintOf(db.insert(otpChallenge).values({ organizationId: org, phone: '+966500000004', email: 'mail@example.com', codeHash: 'b'.repeat(64), expiresAt: new Date() }))).toBe('otp_challenge_destination_check')
      }
      finally {
        await close()
      }
    })
  })
})
