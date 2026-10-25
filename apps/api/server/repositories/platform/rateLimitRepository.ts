import { eq, lt, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { rateLimitBucket } from '@hajj/db/schema'

/**
 * Platform family (unscoped by design): rate-limit counters are keyed by namespaced strings built by
 * `server/security/rateLimit.ts` (client IP, login identifier), not by tenant rows, and are needed
 * before any session or scope exists. Allow-listed in tests/unit/architecture/layering.test.ts.
 */
export class PlatformRateLimitRepository {
  constructor(private readonly db: DbOrTx) {}

  /**
   * Counts one hit for `key` in the window starting at `windowStart` and returns the window's total,
   * atomically: the first hit of a newer window restarts the counter, any other hit increments it (one
   * statement, so concurrent requests can never both see a stale count). A hit stamped with an OLDER window
   * (another API process whose clock lags) counts against the newer one and never moves the window back.
   */
  async hit(key: string, windowStart: Date): Promise<number> {
    const [row] = await this.db.insert(rateLimitBucket)
      .values({ key, windowStart, hits: 1 })
      .onConflictDoUpdate({
        target: rateLimitBucket.key,
        set: {
          hits: sql`case when excluded.window_start > ${rateLimitBucket.windowStart} then 1 else ${rateLimitBucket.hits} + 1 end`,
          windowStart: sql`greatest(${rateLimitBucket.windowStart}, excluded.window_start)`,
        },
      })
      .returning({ hits: rateLimitBucket.hits })
    return row!.hits
  }

  /** Current count for `key` in the window starting at `windowStart` (0 when the stored window is older). */
  async count(key: string, windowStart: Date): Promise<number> {
    const [row] = await this.db.select().from(rateLimitBucket).where(eq(rateLimitBucket.key, key)).limit(1)
    return row && row.windowStart.getTime() >= windowStart.getTime() ? row.hits : 0
  }

  async reset(key: string): Promise<void> {
    await this.db.delete(rateLimitBucket).where(eq(rateLimitBucket.key, key))
  }

  /** Housekeeping: removes buckets whose window started before `before`; returns how many. */
  async deleteOlderThan(before: Date): Promise<number> {
    const rows = await this.db.delete(rateLimitBucket).where(lt(rateLimitBucket.windowStart, before)).returning({ key: rateLimitBucket.key })
    return rows.length
  }
}
