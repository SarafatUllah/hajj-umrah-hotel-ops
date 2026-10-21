import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { agency, agencyUser, auditLog } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import { TooManyRequestsError } from '../../../server/errors/domainError'
import { resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { addAgencyUser, changeAgencyStatus, createAgency, getAgency, getAgencyMe, listAgencies, loginAgencyUser, registerAgency, updateAgencyUser } from '../../../server/services/accounts'
import { login } from '../../../server/services/auth.service'
import { hashPassword } from '../../../server/utils/password'
import { makeOrg, makeUser } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()
const PASSWORD = 'Agency-Passw0rd!'
let ipSequence = 0
/** A fresh client address per call, so the per-address limits never couple unrelated tests. */
const request = (clientIp = `198.51.100.${++ipSequence % 250}`) => ({ clientIp, now: new Date() })

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

function staffCtx(scope: OrganizationScope, userId: string, permissions: string[]): AuthContext {
  return {
    identity: { userId, organizationId: scope.organizationId, email: 'staff@example.test', fullName: 'Staff' },
    authz: { permissions: new Set(permissions) as AuthContext['authz']['permissions'], allHotels: true, hotelIds: new Set() },
    scope,
    db: db as Database,
    now: () => new Date(),
  }
}

let licence = 0
const registration = (slug: string, email = `owner${++licence}@alnoor.test`) => ({
  organizationSlug: slug,
  agency: { name: 'Al-Noor Travels', licenseNo: `LIC-${licence}`, contactName: 'Karim', phone: '+966500000001', email: `office${licence}@alnoor.test` },
  user: { fullName: 'Karim', email, password: PASSWORD },
})

async function setup() {
  const { organization, scope } = await makeOrg(db)
  const manager = await makeUser(db, scope)
  return { slug: organization.slug, scope, admin: staffCtx(scope, manager.id, ['agency.view', 'agency.manage']), viewer: staffCtx(scope, manager.id, ['agency.view']), nobody: staffCtx(scope, manager.id, []) }
}

describe('agency self-registration (public)', () => {
  /** The newest agency of the organization (registration never returns ids: it answers the same for duplicates). */
  const agencies = async (env: Awaited<ReturnType<typeof setup>>) => (await listAgencies(env.viewer, { page: 1, pageSize: 100 })).items

  it('creates a PENDING agency with its first user, audited without a staff actor but with the client address', async () => {
    const env = await setup()
    expect(await registerAgency(registration(env.slug), request('203.0.113.9'))).toEqual({ received: true })

    const [created] = await agencies(env)
    expect(created).toMatchObject({ status: 'PENDING', approvedAt: null })
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, created!.id))
    expect(audits).toEqual([expect.objectContaining({ action: 'AGENCY_REGISTERED', actorUserId: null, afterData: expect.objectContaining({ clientIp: '203.0.113.9' }) })])
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(PASSWORD)
  })

  it('a known licence (any case) or e-mail is silently not registered again — the answer is the same', async () => {
    const env = await setup()
    const first = registration(env.slug)
    await registerAgency(first, request())

    expect(await registerAgency({ ...registration(env.slug), agency: { ...first.agency, licenseNo: ` ${first.agency.licenseNo.toLowerCase()} ` } }, request())).toEqual({ received: true })
    expect(await registerAgency(registration(env.slug, first.user.email), request())).toEqual({ received: true })
    expect(await agencies(env)).toHaveLength(1)
    expect(await db.select().from(agencyUser)).toHaveLength(1)
  })

  it('refuses an unknown organization (422) and a flood from one address (429)', async () => {
    const env = await setup()
    await expect(registerAgency(registration('no-such-org'), request())).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })

    const ip = '203.0.113.200'
    for (let i = 0; i < 5; i++) await registerAgency(registration(env.slug), request(ip))
    await expect(registerAgency(registration(env.slug), request(ip))).rejects.toBeInstanceOf(TooManyRequestsError)
  })
})

describe('staff administration of agencies', () => {
  it('lists and reads with agency.view; changes need agency.manage', async () => {
    const env = await setup()
    await registerAgency(registration(env.slug), request())
    const [registered] = (await listAgencies(env.viewer, { page: 1, pageSize: 20, status: 'PENDING' })).items
    expect(registered).toBeDefined()
    expect((await getAgency(env.viewer, registered!.id)).users).toHaveLength(1)
    await expect(listAgencies(env.nobody, { page: 1, pageSize: 20 })).rejects.toMatchObject({ httpStatus: 403 })
    await expect(changeAgencyStatus(env.viewer, registered!.id, { status: 'APPROVED', reason: 'Licence checked' })).rejects.toMatchObject({ httpStatus: 403 })
    const hotelScoped = { ...env.admin, authz: { ...env.admin.authz, allHotels: false, hotelIds: new Set(['00000000-0000-4000-8000-000000000001']) } }
    await expect(changeAgencyStatus(hotelScoped, registered!.id, { status: 'APPROVED', reason: 'Licence checked' })).rejects.toMatchObject({ httpStatus: 403 })
  })

  it('approve → suspend → approve; impossible transitions are 409; every decision is audited with its reason', async () => {
    const env = await setup()
    await registerAgency(registration(env.slug), request())
    const [registered] = (await listAgencies(env.viewer, { page: 1, pageSize: 20 })).items as [{ id: string }]

    expect(await changeAgencyStatus(env.admin, registered.id, { status: 'APPROVED', reason: 'Licence checked' })).toMatchObject({ status: 'APPROVED', approvedAt: expect.any(String) })
    await expect(changeAgencyStatus(env.admin, registered.id, { status: 'REJECTED', reason: 'Too late' })).rejects.toMatchObject({ code: 'AGENCY_STATUS_TRANSITION', httpStatus: 409 })
    expect((await changeAgencyStatus(env.admin, registered.id, { status: 'SUSPENDED', reason: 'Complaint' })).status).toBe('SUSPENDED')
    expect((await changeAgencyStatus(env.admin, registered.id, { status: 'APPROVED', reason: 'Resolved' })).status).toBe('APPROVED')

    const decisions = await db.select().from(auditLog).where(and(eq(auditLog.entityId, registered.id), eq(auditLog.action, 'AGENCY_STATUS_CHANGED')))
    expect(decisions.map(d => d.reason).sort()).toEqual(['Complaint', 'Licence checked', 'Resolved'])
  })

  it('a staff-created agency is approved at once; another organization\'s agency is not found', async () => {
    const env = await setup()
    const created = await createAgency(env.admin, { agency: registration(env.slug).agency, user: registration(env.slug).user })
    expect(created).toMatchObject({ status: 'APPROVED', users: [expect.objectContaining({ isActive: true })] })

    const other = await setup()
    await expect(getAgency(other.admin, created.id)).rejects.toMatchObject({ code: 'AGENCY_NOT_FOUND', httpStatus: 404 })
    await expect(changeAgencyStatus(other.admin, created.id, { status: 'SUSPENDED', reason: 'x'.repeat(5) })).rejects.toMatchObject({ httpStatus: 404 })
  })

  it('adds users; deactivating one ends its sessions; a user of another agency is not found', async () => {
    const env = await setup()
    const a = await createAgency(env.admin, { agency: registration(env.slug).agency, user: registration(env.slug).user })
    const b = await createAgency(env.admin, { agency: registration(env.slug).agency, user: registration(env.slug).user })
    const second = await addAgencyUser(env.admin, a.id, { fullName: 'Second', email: 'second@alnoor.test', password: PASSWORD })

    const deactivated = await updateAgencyUser(env.admin, a.id, second.id, { isActive: false })
    expect(deactivated.isActive).toBe(false)
    const [row] = await db.select().from(agencyUser).where(eq(agencyUser.id, second.id))
    expect(row!.sessionVersion).toBe(2)
    await expect(updateAgencyUser(env.admin, b.id, second.id, { isActive: true })).rejects.toMatchObject({ code: 'AGENCY_USER_NOT_FOUND' })
  })
})

describe('agency sign-in and session resolution', () => {
  async function approvedAgency() {
    const env = await setup()
    const reg = registration(env.slug)
    const created = await createAgency(env.admin, { agency: reg.agency, user: reg.user })
    return { env, created, email: reg.user.email }
  }

  it('the right password signs in; every failure looks the same; an inactive user cannot', async () => {
    const { env, created, email } = await approvedAgency()
    const user = await loginAgencyUser({ organizationSlug: env.slug, email: email.toUpperCase(), password: PASSWORD }, request())
    expect(user).toMatchObject({ agencyId: created.id, email, sessionVersion: 1 })

    expect(await loginAgencyUser({ organizationSlug: env.slug, email, password: 'wrong-password' }, request())).toBeNull()
    expect(await loginAgencyUser({ organizationSlug: 'no-such-org', email, password: PASSWORD }, request())).toBeNull()
    await updateAgencyUser(env.admin, created.id, created.users[0]!.id, { isActive: false })
    expect(await loginAgencyUser({ organizationSlug: env.slug, email, password: PASSWORD }, request())).toBeNull()
  })

  it('agency and staff sign-ins never share failure counters, even with the same e-mail', async () => {
    const { env, email } = await approvedAgency()
    await makeUser(db, env.scope, { email, passwordHash: await hashPassword(PASSWORD) })
    const ip = '203.0.113.77'
    for (let i = 0; i < 5; i++) await loginAgencyUser({ organizationSlug: env.slug, email, password: 'wrong' }, request(ip))
    await expect(loginAgencyUser({ organizationSlug: env.slug, email, password: PASSWORD }, request(ip))).rejects.toBeInstanceOf(TooManyRequestsError)
    expect((await login({ organizationSlug: env.slug, email, password: PASSWORD }, request(ip))).status).toBe('ok')
  })

  it('the context is resolved fresh: status changes show at once; deactivation, a version change or another agency end the session', async () => {
    const { env, created } = await approvedAgency()
    const userId = created.users[0]!.id
    const identity = { agencyUserId: userId, organizationId: env.scope.organizationId, agencyId: created.id, sessionVersion: 1 }

    const ctx = (await resolveAgencyContext(db as Database, identity))!
    expect(ctx).toMatchObject({ agency: { id: created.id, status: 'APPROVED' }, scope: { agencyId: created.id } })
    expect(getAgencyMe(ctx).agency).toEqual({ id: created.id, name: created.name, status: 'APPROVED' })

    await changeAgencyStatus(env.admin, created.id, { status: 'SUSPENDED', reason: 'Complaint' })
    expect((await resolveAgencyContext(db as Database, identity))!.agency.status).toBe('SUSPENDED')
    expect(await resolveAgencyContext(db as Database, { ...identity, agencyId: (await setup()).scope.organizationId })).toBeNull()
    expect(await resolveAgencyContext(db as Database, { ...identity, sessionVersion: 7 })).toBeNull()
    await db.update(agencyUser).set({ isActive: false }).where(eq(agencyUser.id, userId))
    expect(await resolveAgencyContext(db as Database, identity)).toBeNull()
    expect(await db.select().from(agency).where(eq(agency.id, created.id))).toHaveLength(1)
  })
})
