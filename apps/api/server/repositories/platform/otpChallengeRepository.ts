import { lt } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { otpChallenge } from '@hajj/db/schema'

/**
 * Platform family (unscoped by design): the daily cleanup removes expired sign-in codes of every organization.
 * Allow-listed in tests/unit/architecture/layering.test.ts. Reads nothing and returns only a count.
 */
export class PlatformOtpChallengeRepository {
  constructor(private readonly db: DbOrTx) {}

  async deleteExpiredBefore(before: Date): Promise<number> {
    const rows = await this.db.delete(otpChallenge).where(lt(otpChallenge.expiresAt, before)).returning({ id: otpChallenge.id })
    return rows.length
  }
}
