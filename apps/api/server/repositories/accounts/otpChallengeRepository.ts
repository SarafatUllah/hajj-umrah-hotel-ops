import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { otpChallenge } from '@hajj/db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type OtpChallengeRow = typeof otpChallenge.$inferSelect
export type NewOtpChallenge = Omit<typeof otpChallenge.$inferInsert, 'organizationId'>

/** Customer sign-in codes (hashed). Attempts and consumption are single atomic UPDATEs, safe under concurrency. */
export class OtpChallengeRepository {
  private readonly q: OrgQuery

  constructor(db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async insert(values: NewOtpChallenge): Promise<OtpChallengeRow> {
    const [row] = await this.q.insert(otpChallenge, values).returning()
    return row!
  }

  /**
   * Counts one attempt at a still-open challenge (not consumed, not expired at `now`, fewer than `maxAttempts`
   * so far) and returns it; null when the challenge is unknown, closed or out of attempts — atomically, so
   * parallel guesses can never exceed `maxAttempts`.
   */
  async registerAttempt(id: string, now: Date, maxAttempts: number): Promise<OtpChallengeRow | null> {
    const [row] = await this.q.update(otpChallenge, { attempts: sql`${otpChallenge.attempts} + 1` }, eq(otpChallenge.id, id), isNull(otpChallenge.consumedAt), gt(otpChallenge.expiresAt, now), lt(otpChallenge.attempts, maxAttempts)).returning()
    return row ?? null
  }

  /** Closes every still-open challenge of `phone` (a new code replaces the older ones: one live code per phone). */
  async closeOpenForPhone(phone: string, at: Date): Promise<void> {
    await this.q.update(otpChallenge, { consumedAt: at }, eq(otpChallenge.phone, phone), isNull(otpChallenge.consumedAt))
  }

  /** Marks the challenge used; true only for the one caller that consumed it. */
  async consume(id: string, at: Date): Promise<boolean> {
    const rows = await this.q.update(otpChallenge, { consumedAt: at }, and(eq(otpChallenge.id, id), isNull(otpChallenge.consumedAt))).returning({ id: otpChallenge.id })
    return rows.length > 0
  }
}
