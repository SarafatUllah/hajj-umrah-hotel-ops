import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { appUser } from '@hajj/db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type UserRow = typeof appUser.$inferSelect
export type NewUser = Omit<typeof appUser.$inferInsert, 'organizationId'>

export class UserRepository {
  private readonly q: OrgQuery

  constructor(db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  /** Login lookup. The email must already be normalized (shared/utils/email). */
  async findActiveByEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.q.select(appUser, and(eq(appUser.email, email), eq(appUser.isActive, true)), { limit: 1 })
    return row ?? null
  }

  /** Any user with this email in the organization, active or not (the seed adopts an existing demo admin). */
  async findByEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.q.select(appUser, eq(appUser.email, email), { limit: 1 })
    return row ?? null
  }

  async findById(id: string): Promise<UserRow | null> {
    const [row] = await this.q.select(appUser, eq(appUser.id, id), { limit: 1 })
    return row ?? null
  }

  /**
   * Same lookup as `findById`, but row-locking (`SELECT ... FOR UPDATE`) — for callers that read a
   * user's mutable state (e.g. `allHotels`) and then write based on it in the same transaction, so a
   * concurrent writer targeting the same row serializes behind this one instead of racing it on a
   * stale read. Only valid inside a transaction: construct this repository with a `tx` handle, never
   * a bare `Database` handle, when calling this method.
   */
  async findByIdForUpdate(id: string): Promise<UserRow | null> {
    const [row] = await this.q.select(appUser, eq(appUser.id, id), { limit: 1, forUpdate: true })
    return row ?? null
  }

  async insert(values: NewUser): Promise<UserRow> {
    const [row] = await this.q.insert(appUser, values).returning()
    return row!
  }

  async setAllHotels(userId: string, value: boolean): Promise<void> {
    await this.q.update(appUser, { allHotels: value }, eq(appUser.id, userId))
  }

  /** Stores (or clears, with `null`) the encrypted secret of a TOTP enrolment that is not confirmed yet. */
  async setPendingTotpSecret(userId: string, encryptedSecret: string | null): Promise<void> {
    await this.q.update(appUser, { totpPendingSecret: encryptedSecret, updatedAt: new Date() }, eq(appUser.id, userId))
  }

  /**
   * Confirms an enrolment: the encrypted secret becomes active, the pending one is cleared, `step` (the
   * step of the confirming code) is recorded so that code can never be replayed, and the session version
   * is bumped (every other session ends). Returns the new session version, or null when no such user is in scope.
   */
  async enableTotp(userId: string, encryptedSecret: string, enabledAt: Date, step: number): Promise<number | null> {
    const [row] = await this.q.update(appUser, { totpSecret: encryptedSecret, totpPendingSecret: null, totpEnabledAt: enabledAt, totpLastStep: step, sessionVersion: sql`${appUser.sessionVersion} + 1`, updatedAt: enabledAt }, eq(appUser.id, userId)).returning({ sessionVersion: appUser.sessionVersion })
    return row?.sessionVersion ?? null
  }

  /** Removes the second factor (self-service disable or an admin reset) and bumps the session version; returns it, or null. */
  async disableTotp(userId: string): Promise<number | null> {
    const [row] = await this.q.update(appUser, { totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null, sessionVersion: sql`${appUser.sessionVersion} + 1`, updatedAt: new Date() }, eq(appUser.id, userId)).returning({ sessionVersion: appUser.sessionVersion })
    return row?.sessionVersion ?? null
  }

  /**
   * Atomically records `step` as the last accepted TOTP step, only if it is later than the stored one —
   * two concurrent logins with the same code cannot both succeed. Returns whether this call won.
   */
  async advanceTotpStep(userId: string, step: number): Promise<boolean> {
    const rows = await this.q.update(appUser, { totpLastStep: step }, eq(appUser.id, userId), or(isNull(appUser.totpLastStep), lt(appUser.totpLastStep, step))).returning({ id: appUser.id })
    return rows.length > 0
  }
}
