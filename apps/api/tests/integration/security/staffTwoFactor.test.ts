import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { appUser, auditLog } from '@hajj/db/schema'
import { TooManyRequestsError } from '../../../server/errors/domainError'
import { platformRepos, tenantRepos } from '../../../server/repositories'
import { resolveAuthContext, type AuthContext } from '../../../server/security/authContext'
import { bucketKey, RATE_LIMITS, windowStartFor } from '../../../server/security/rateLimit'
import type { OrganizationScope } from '../../../server/security/scope'
import { totpCodeAt, totpStepAt } from '../../../server/security/totp'
import { login, type LoginInput } from '../../../server/services/auth.service'
import { beginTwoFactorSetup, confirmTwoFactorSetup, disableTwoFactor, getTwoFactorStatus, resetTwoFactor } from '../../../server/services/twoFactorService'
import { hashPassword } from '../../../server/utils/password'
import { makeOrg, makeRole, makeUser, makeUserWithPermissions } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()
const NOW = new Date('2026-10-21T10:00:05.000Z')
const STEP = totpStepAt(NOW)
const PASSWORD = 'Staff-Passw0rd!'
const request = (clientIp = '198.51.100.10') => ({ clientIp, now: NOW })

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

interface Staff {
  slug: string
  scope: OrganizationScope
  userId: string
  email: string
  ctx: AuthContext
}

const contextFor = async (scope: OrganizationScope, userId: string) =>
  (await resolveAuthContext(db, { userId, organizationId: scope.organizationId }, () => NOW))!

async function makeStaff(options: { requiresTwoFactor?: boolean, scope?: OrganizationScope, slug?: string } = {}): Promise<Staff> {
  const org = options.scope ? { scope: options.scope, slug: options.slug! } : await makeOrg(db).then(o => ({ scope: o.scope, slug: o.organization.slug }))
  const user = await makeUser(db, org.scope, { passwordHash: await hashPassword(PASSWORD) })
  const role = await makeRole(db, org.scope)
  const repos = tenantRepos(db, org.scope)
  await repos.roles.assignToUser(user.id, role.id)
  if (options.requiresTwoFactor) await repos.roles.setRequiresTwoFactor(role.id, true)
  return { slug: org.slug, scope: org.scope, userId: user.id, email: user.email, ctx: await contextFor(org.scope, user.id) }
}

/** Enrols the staff user (confirming with the code of STEP) and returns the secret. */
async function enrol(staff: Staff): Promise<string> {
  const { secret } = await beginTwoFactorSetup(staff.ctx)
  await confirmTwoFactorSetup(staff.ctx, totpCodeAt(secret, STEP))
  return secret
}

const credentials = (staff: Staff, extra: Partial<LoginInput> = {}): LoginInput => ({ organizationSlug: staff.slug, email: staff.email, password: PASSWORD, ...extra })
const userRow = async (userId: string) => (await db.select().from(appUser).where(eq(appUser.id, userId)))[0]!
const auditActions = async (userId: string) => (await db.select().from(auditLog).where(eq(auditLog.entityId, userId))).map(a => a.action).sort()

describe('login: rate limits', () => {
  it('one client address gets 5 attempts per identity (then 429, even with the right password); another address is unaffected', async () => {
    const staff = await makeStaff()
    for (let i = 0; i < RATE_LIMITS.loginPerClientIdentity.limit; i++) {
      expect(await login(credentials(staff, { password: 'wrong' }), request('203.0.113.1'))).toEqual({ status: 'invalid-credentials' })
    }

    await expect(login(credentials(staff), request('203.0.113.1'))).rejects.toBeInstanceOf(TooManyRequestsError)
    expect((await login(credentials(staff), request('203.0.113.2'))).status).toBe('ok')
  })

  it('distributed guessing is bounded per identity across all addresses', async () => {
    const staff = await makeStaff()
    const perClient = RATE_LIMITS.loginPerClientIdentity.limit
    for (let i = 0; i < RATE_LIMITS.loginPerIdentity.limit; i++) {
      await login(credentials(staff, { password: 'wrong' }), request(`203.0.113.${Math.floor(i / perClient)}`))
    }
    await expect(login(credentials(staff), request('192.0.2.200'))).rejects.toBeInstanceOf(TooManyRequestsError)
  })

  it('parallel wrong guesses never get more password checks than the limit', async () => {
    const staff = await makeStaff()
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => login(credentials(staff, { password: 'wrong' }), request())))

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(RATE_LIMITS.loginPerClientIdentity.limit)
    expect(results.filter(r => r.status === 'rejected' && r.reason instanceof TooManyRequestsError)).toHaveLength(12 - RATE_LIMITS.loginPerClientIdentity.limit)
  })

  it('treats the identity case-insensitively (slug and email are normalized)', async () => {
    const staff = await makeStaff()
    for (let i = 0; i < RATE_LIMITS.loginPerClientIdentity.limit; i++) {
      await login(credentials(staff, { organizationSlug: staff.slug.toUpperCase(), email: staff.email.toUpperCase(), password: 'wrong' }), request())
    }
    await expect(login(credentials(staff), request())).rejects.toBeInstanceOf(TooManyRequestsError)
  })

  it('a successful login gives the identity its attempts back', async () => {
    const staff = await makeStaff()
    const almost = RATE_LIMITS.loginPerClientIdentity.limit - 1
    for (let i = 0; i < almost; i++) await login(credentials(staff, { password: 'wrong' }), request())
    expect((await login(credentials(staff), request())).status).toBe('ok')
    for (let i = 0; i < almost; i++) await login(credentials(staff, { password: 'wrong' }), request())
    expect((await login(credentials(staff), request())).status).toBe('ok')
  })

  it('refuses every attempt from an address over its limit, even with the right password', async () => {
    const staff = await makeStaff()
    const windowStart = windowStartFor(RATE_LIMITS.loginPerIp, NOW)
    const key = bucketKey(RATE_LIMITS.loginPerIp, '198.51.100.66')
    for (let i = 0; i < RATE_LIMITS.loginPerIp.limit; i++) await platformRepos(db).rateLimits.hit(key, windowStart)

    await expect(login(credentials(staff), request('198.51.100.66'))).rejects.toBeInstanceOf(TooManyRequestsError)
    expect((await login(credentials(staff), request('198.51.100.67'))).status).toBe('ok')
  })

  it('a successful login returns the user\'s session version', async () => {
    const staff = await makeStaff()
    expect(await login(credentials(staff), request())).toMatchObject({ status: 'ok', session: { sessionVersion: 1 } })
  })
})

describe('staff two-factor authentication (TOTP)', () => {
  it('enrolment: setup stores an encrypted pending secret (audited), enable activates it, bumps the session version and audits', async () => {
    const staff = await makeStaff()
    expect(await getTwoFactorStatus(staff.ctx)).toEqual({ enabled: false, setupPending: false, requiredByRole: false })

    const setup = await beginTwoFactorSetup(staff.ctx)
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`)
    const pending = await userRow(staff.userId)
    expect(pending.totpPendingSecret).toMatch(/^pii1\./)
    expect(pending.totpPendingSecret).not.toContain(setup.secret)
    expect(await getTwoFactorStatus(staff.ctx)).toMatchObject({ enabled: false, setupPending: true })

    expect(await confirmTwoFactorSetup(staff.ctx, totpCodeAt(setup.secret, STEP))).toBe(2)

    const enabled = await userRow(staff.userId)
    expect(enabled.totpSecret).toBe(pending.totpPendingSecret)
    expect(enabled).toMatchObject({ totpPendingSecret: null, totpLastStep: STEP, sessionVersion: 2 })
    expect(await getTwoFactorStatus(staff.ctx)).toMatchObject({ enabled: true, setupPending: false })
    expect(await auditActions(staff.userId)).toEqual(['TWO_FACTOR_ENABLED', 'TWO_FACTOR_SETUP_STARTED'])
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, staff.userId))
    expect(JSON.stringify(audits)).not.toContain(setup.secret)
  })

  it('enable rejects a wrong code (422) and requires a started setup (409); setup and enable refuse an enrolled user (409)', async () => {
    const staff = await makeStaff()
    await expect(confirmTwoFactorSetup(staff.ctx, '000000')).rejects.toMatchObject({ code: 'TWO_FACTOR_SETUP_REQUIRED', httpStatus: 409 })

    const { secret } = await beginTwoFactorSetup(staff.ctx)
    await expect(confirmTwoFactorSetup(staff.ctx, totpCodeAt(secret, STEP + 5))).rejects.toMatchObject({ code: 'TWO_FACTOR_CODE_INVALID', httpStatus: 422 })

    await confirmTwoFactorSetup(staff.ctx, totpCodeAt(secret, STEP))
    await expect(beginTwoFactorSetup(staff.ctx)).rejects.toMatchObject({ code: 'TWO_FACTOR_ALREADY_ENABLED', httpStatus: 409 })
    await expect(confirmTwoFactorSetup(staff.ctx, totpCodeAt(secret, STEP))).rejects.toMatchObject({ code: 'TWO_FACTOR_ALREADY_ENABLED' })
  })

  it('a restarted setup replaces the earlier pending secret', async () => {
    const staff = await makeStaff()
    const first = await beginTwoFactorSetup(staff.ctx)
    const second = await beginTwoFactorSetup(staff.ctx)
    expect(second.secret).not.toBe(first.secret)
    await expect(confirmTwoFactorSetup(staff.ctx, totpCodeAt(first.secret, STEP))).rejects.toMatchObject({ code: 'TWO_FACTOR_CODE_INVALID' })
    await confirmTwoFactorSetup(staff.ctx, totpCodeAt(second.secret, STEP))
  })

  it('login of an enrolled user: no code → two-factor-required, wrong code → invalid, valid code → ok, replayed code → invalid', async () => {
    const staff = await makeStaff()
    const secret = await enrol(staff)

    expect(await login(credentials(staff), request())).toEqual({ status: 'two-factor-required' })
    expect(await login(credentials(staff, { totpCode: totpCodeAt(secret, STEP + 7) }), request())).toEqual({ status: 'invalid-two-factor' })
    // The enrolment code (STEP) was recorded: it can never log in.
    expect(await login(credentials(staff, { totpCode: totpCodeAt(secret, STEP) }), request())).toEqual({ status: 'invalid-two-factor' })

    const next = totpCodeAt(secret, STEP + 1)
    expect(await login(credentials(staff, { totpCode: next }), request())).toMatchObject({ status: 'ok', session: { sessionVersion: 2 } })
    expect(await login(credentials(staff, { totpCode: next }), request())).toEqual({ status: 'invalid-two-factor' })
  })

  it('a wrong password never reveals whether a second factor is enrolled', async () => {
    const staff = await makeStaff()
    await enrol(staff)
    expect(await login(credentials(staff, { password: 'wrong' }), request())).toEqual({ status: 'invalid-credentials' })
  })

  it('two concurrent logins with the same code: exactly one succeeds', async () => {
    const staff = await makeStaff()
    const secret = await enrol(staff)
    const code = totpCodeAt(secret, STEP + 1)

    const results = await Promise.all([login(credentials(staff, { totpCode: code }), request('203.0.113.1')), login(credentials(staff, { totpCode: code }), request('203.0.113.2'))])
    expect(results.map(r => r.status).sort()).toEqual(['invalid-two-factor', 'ok'])
  })

  it('second-factor codes are limited per user across addresses (5, then 429 even for the right code); parallel guesses cannot exceed it', async () => {
    const staff = await makeStaff()
    const secret = await enrol(staff)
    const wrong = totpCodeAt(secret, STEP + 9)
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => login(credentials(staff, { totpCode: wrong }), request(`203.0.113.${i}`))))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(RATE_LIMITS.twoFactorAttemptsPerUser.limit)

    await expect(login(credentials(staff, { totpCode: totpCodeAt(secret, STEP + 1) }), request('192.0.2.9'))).rejects.toBeInstanceOf(TooManyRequestsError)
  })

  it('disable needs a current code (409 when not enrolled, 422 for a wrong one), bumps the session version, audits; 5 attempts per window', async () => {
    const staff = await makeStaff()
    await expect(disableTwoFactor(staff.ctx, '123456')).rejects.toMatchObject({ code: 'TWO_FACTOR_NOT_ENABLED', httpStatus: 409 })
    const secret = await enrol(staff)

    await expect(disableTwoFactor(staff.ctx, totpCodeAt(secret, STEP))).rejects.toMatchObject({ code: 'TWO_FACTOR_CODE_INVALID', httpStatus: 422 })
    expect(await disableTwoFactor(staff.ctx, totpCodeAt(secret, STEP + 1))).toBe(3)

    expect(await userRow(staff.userId)).toMatchObject({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null, sessionVersion: 3 })
    expect(await auditActions(staff.userId)).toContain('TWO_FACTOR_DISABLED')
    expect((await login(credentials(staff), request())).status).toBe('ok')

    const again = await enrol(staff)
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => disableTwoFactor(staff.ctx, totpCodeAt(again, STEP + 9))))
    expect(results.filter(r => r.status === 'rejected' && r.reason instanceof TooManyRequestsError)).toHaveLength(8 - RATE_LIMITS.twoFactorAttemptsPerUser.limit)
    await expect(disableTwoFactor(staff.ctx, totpCodeAt(again, STEP + 1))).rejects.toBeInstanceOf(TooManyRequestsError)
  })

  it('a secret copied onto another user\'s row does not decrypt (the ciphertext is bound to its user)', async () => {
    const victim = await makeStaff()
    await enrol(victim)
    const victimRow = await userRow(victim.userId)

    const other = await makeStaff()
    await db.update(appUser).set({ totpSecret: victimRow.totpSecret, totpEnabledAt: NOW }).where(eq(appUser.id, other.userId))

    await expect(login(credentials(other, { totpCode: '123456' }), request())).rejects.toThrow(/could not be decrypted/)
  })
})

describe('session version', () => {
  it('a session minted before a 2FA change no longer resolves; one carrying the current version does', async () => {
    const staff = await makeStaff()
    const identity = { userId: staff.userId, organizationId: staff.scope.organizationId }
    expect(await resolveAuthContext(db, { ...identity, sessionVersion: 1 })).not.toBeNull()

    await enrol(staff)
    expect(await resolveAuthContext(db, { ...identity, sessionVersion: 1 })).toBeNull()
    expect(await resolveAuthContext(db, { ...identity, sessionVersion: 2 })).not.toBeNull()
  })
})

describe('administrator 2FA reset (lost device)', () => {
  async function makeAdmin(scope: OrganizationScope, allHotels: boolean) {
    const { user } = await makeUserWithPermissions(db, scope, ['user.manage'], { allHotels })
    return contextFor(scope, user.id)
  }

  it('removes the target\'s second factor and pending setup, signs them out everywhere and audits the reason', async () => {
    const target = await makeStaff()
    await enrol(target)
    const admin = await makeAdmin(target.scope, true)

    await resetTwoFactor(admin, target.userId, 'Phone lost, verified by phone call')

    expect(await userRow(target.userId)).toMatchObject({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, sessionVersion: 3 })
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, target.userId), eq(auditLog.action, 'TWO_FACTOR_RESET')))
    expect(audit).toMatchObject({ actorUserId: admin.identity.userId, reason: 'Phone lost, verified by phone call' })
    expect((await login(credentials(target), request())).status).toBe('ok')
  })

  it('also clears a pending setup; refuses without user.manage (403), for oneself (403), across organizations (404) and when nothing is enrolled (409)', async () => {
    const target = await makeStaff()
    await beginTwoFactorSetup(target.ctx)
    const admin = await makeAdmin(target.scope, true)
    const plain = (await makeStaff({ scope: target.scope, slug: target.slug })).ctx
    const foreignAdmin = await makeAdmin((await makeOrg(db)).scope, true)

    await expect(resetTwoFactor(plain, target.userId, 'reason')).rejects.toMatchObject({ httpStatus: 403 })
    await expect(resetTwoFactor(admin, admin.identity.userId, 'reason')).rejects.toMatchObject({ code: 'ESCALATION_DENIED' })
    await expect(resetTwoFactor(foreignAdmin, target.userId, 'reason')).rejects.toMatchObject({ httpStatus: 404 })

    await resetTwoFactor(admin, target.userId, 'restart enrolment')
    expect((await userRow(target.userId)).totpPendingSecret).toBeNull()
    await expect(resetTwoFactor(admin, target.userId, 'again')).rejects.toMatchObject({ code: 'TWO_FACTOR_NOT_ENABLED', httpStatus: 409 })
  })

  it('an administrator without allHotels can never reset a user who has it', async () => {
    const { organization, scope } = await makeOrg(db)
    const superUser = await makeUser(db, scope, { passwordHash: await hashPassword(PASSWORD), allHotels: true })
    const target: Staff = { slug: organization.slug, scope, userId: superUser.id, email: superUser.email, ctx: await contextFor(scope, superUser.id) }
    await enrol(target)
    const limitedAdmin = await makeAdmin(scope, false)

    await expect(resetTwoFactor(limitedAdmin, target.userId, 'reason')).rejects.toMatchObject({ code: 'ESCALATION_DENIED' })
    expect((await userRow(target.userId)).totpSecret).not.toBeNull()
  })
})

describe('resolveAuthContext: two-factor enrollment enforcement', () => {
  const resolve = (staff: Staff, enforceTwoFactor: boolean) =>
    resolveAuthContext(db, { userId: staff.userId, organizationId: staff.scope.organizationId }, () => NOW, { enforceTwoFactor })

  it('pending only with enforcement on, a role requiring 2FA, and no enrolment', async () => {
    const required = await makeStaff({ requiresTwoFactor: true })
    const notRequired = await makeStaff()

    expect((await resolve(required, true))?.twoFactorEnrollmentPending).toBe(true)
    expect((await resolve(required, false))?.twoFactorEnrollmentPending).toBe(false)
    expect((await resolve(notRequired, true))?.twoFactorEnrollmentPending).toBe(false)
    expect(await getTwoFactorStatus(required.ctx)).toMatchObject({ requiredByRole: true })

    await enrol(required)
    expect((await resolve(required, true))?.twoFactorEnrollmentPending).toBe(false)
  })
})
