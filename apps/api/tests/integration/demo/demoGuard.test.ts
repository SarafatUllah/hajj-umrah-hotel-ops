import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { appUser, organization, permission, role, rolePermission, roomOperationalBlock, userRole } from '../../../db/schema'
import { DemoSeedForbiddenError, DEMO_ORG_SLUG, seedDemoOrganization } from '../../../db/seed/demo-org'
import { demoIds } from '../../../db/seed/demo/ids'
import { DEMO_ADMIN_EMAIL, DEMO_PASSWORD } from '../../../server/demo/personas'
import { resolveAuthContext } from '../../../server/security/authContext'
import { authenticate } from '../../../server/services/auth.service'
import { resetDemoData } from '../../../server/services/demo.service'
import { resetEnvCache } from '../../../server/utils/env'
import { hashPassword } from '../../../server/utils/password'
import { fingerprintOrganization } from '../../support/fingerprint'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()
const DEMO_ORG_ID = demoIds.organization(DEMO_ORG_SLUG)
const original = { ...process.env }

beforeEach(async () => {
  await truncateAllTables()
})

afterEach(() => {
  process.env = { ...original }
  resetEnvCache()
})

afterAll(async () => {
  await truncateAllTables()
  await closeTestDb()
})

describe('production seed guard (ALLOW_DEMO_SEED)', () => {
  it('refuses to seed under APP_ENV=production without ALLOW_DEMO_SEED=true, and writes nothing', async () => {
    await expect(seedDemoOrganization(db, { env: { APP_ENV: 'production' } })).rejects.toBeInstanceOf(DemoSeedForbiddenError)
    await expect(seedDemoOrganization(db, { env: { APP_ENV: 'production', ALLOW_DEMO_SEED: 'false' } })).rejects.toBeInstanceOf(DemoSeedForbiddenError)
    expect(await db.select().from(organization)).toEqual([])
    expect(await db.select().from(appUser)).toEqual([])
  })

  it('seeds under APP_ENV=production when ALLOW_DEMO_SEED=true is set deliberately', async () => {
    const r = await seedDemoOrganization(db, { env: { APP_ENV: 'production', ALLOW_DEMO_SEED: 'true' } })
    expect(r.organizationId).toBe(DEMO_ORG_ID)
    expect(r.summary).toMatchObject({ hotels: 5, rooms: 360, users: 9 })
  })

  it.each(['development', 'demo', 'staging'])('seeds under APP_ENV=%s without any override', async (appEnv) => {
    await truncateAllTables()
    expect((await seedDemoOrganization(db, { env: { APP_ENV: appEnv } })).summary.rooms).toBe(360)
  })

  it('the real process environment is honoured (the default source), and an existing demo organization is left untouched by a refused production seed', async () => {
    await seedDemoOrganization(db)
    const before = await fingerprintOrganization(db, DEMO_ORG_ID)
    process.env.APP_ENV = 'production'
    delete process.env.ALLOW_DEMO_SEED
    await expect(seedDemoOrganization(db)).rejects.toBeInstanceOf(DemoSeedForbiddenError)
    expect((await fingerprintOrganization(db, DEMO_ORG_ID)).hash).toBe(before.hash)
  })

  it('the demo reset service is guarded the same way: refused in production without the override (nothing changes), allowed with it', async () => {
    await seedDemoOrganization(db)
    const before = await fingerprintOrganization(db, DEMO_ORG_ID)
    const actor = { userId: demoIds.user('admin'), organizationId: DEMO_ORG_ID }

    process.env.APP_ENV = 'production'
    delete process.env.ALLOW_DEMO_SEED
    await expect(resetDemoData(actor)).rejects.toBeInstanceOf(DemoSeedForbiddenError)
    expect((await fingerprintOrganization(db, DEMO_ORG_ID)).hash).toBe(before.hash)

    process.env.ALLOW_DEMO_SEED = 'true'
    expect((await resetDemoData(actor)).organizationId).toBe(DEMO_ORG_ID)
    expect((await fingerprintOrganization(db, DEMO_ORG_ID)).hash).toBe(before.hash)
  })

  it('an invalid demo environment is a configuration error, never a silent default', async () => {
    await expect(seedDemoOrganization(db, { env: { DEMO_ANCHOR_DATE: '2026-02-30' } })).rejects.toThrow(/DEMO_ANCHOR_DATE/)
    await expect(seedDemoOrganization(db, { env: { ALLOW_DEMO_SEED: 'yes' } })).rejects.toThrow(/ALLOW_DEMO_SEED/)
    await expect(seedDemoOrganization(db, { env: { APP_ENV: 'production', ALLOW_DEMO_SEED: 'true', DEMO_SIGN_IN_ENABLED: 'true' } })).rejects.toThrow(/DEMO_SIGN_IN_ENABLED/)
    await expect(seedDemoOrganization(db, { anchorDate: '2026-13-01' })).rejects.toThrow(/anchor/i)
    expect(await db.select().from(organization)).toEqual([])
  })
})

describe('DEMO_ANCHOR_DATE', () => {
  const firstRunningBlock = async () => {
    const [b] = await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.id, demoIds.block('MKK-GRAND', 'maintenance-running-0')))
    return [b!.startDate, b!.endDate]
  }

  it('extreme but allowed anchors (window edges) still generate a complete, valid dataset; outside the window is refused', async () => {
    for (const anchorDate of ['2000-01-01', '2100-12-31']) {
      const r = await seedDemoOrganization(db, { anchorDate })
      expect(r.summary).toMatchObject({ rooms: 360, hotels: 5, users: 9 })
      // Far from the inventory era (2025+) most anchor-relative blocks find no room in inventory and are skipped, never forced.
      expect(r.summary.blocks).toBeGreaterThanOrEqual(0)
    }
    await expect(seedDemoOrganization(db, { anchorDate: '1999-12-31' })).rejects.toThrow(/anchor/i)
    await expect(seedDemoOrganization(db, { anchorDate: '2101-01-01' })).rejects.toThrow(/anchor/i)
  })

  it('is read from the environment (default 2026-09-01) and an explicit option wins', async () => {
    expect((await seedDemoOrganization(db, { env: {} })).summary.anchorDate).toBe('2026-09-01')
    const fromDefault = await firstRunningBlock()
    expect((await seedDemoOrganization(db, { env: { DEMO_ANCHOR_DATE: '2027-01-10' } })).summary.anchorDate).toBe('2027-01-10')
    expect(await firstRunningBlock()).not.toEqual(fromDefault)
    expect((await seedDemoOrganization(db, { env: { DEMO_ANCHOR_DATE: '2027-01-10' }, anchorDate: '2026-09-01' })).summary.anchorDate).toBe('2026-09-01')
    expect(await firstRunningBlock()).toEqual(fromDefault)
  })
})

describe('Phase 0 regressions retained', () => {
  it('never adopts a same-email user from another organization as the demo admin', async () => {
    const [foreignOrg] = await db.insert(organization).values({ name: 'Foreign Org', slug: 'foreign-org' }).returning()
    const [foreignRole] = await db.insert(role).values({ organizationId: foreignOrg!.id, key: 'VIEWER', name: 'Viewer' }).returning()
    await db.insert(permission).values({ key: 'booking.view', description: 'View bookings' }).onConflictDoNothing()
    await db.insert(rolePermission).values({ roleId: foreignRole!.id, permissionKey: 'booking.view' })
    const [foreignUser] = await db.insert(appUser).values({ organizationId: foreignOrg!.id, email: DEMO_ADMIN_EMAIL, passwordHash: await hashPassword('foreign-org-password'), fullName: 'Foreign User' }).returning()
    await db.insert(userRole).values({ organizationId: foreignOrg!.id, userId: foreignUser!.id, roleId: foreignRole!.id })
    const foreignBefore = await fingerprintOrganization(db, foreignOrg!.id)

    await seedDemoOrganization(db)
    await seedDemoOrganization(db)

    expect((await fingerprintOrganization(db, foreignOrg!.id)).hash).toBe(foreignBefore.hash)
    const foreignCtx = await resolveAuthContext(db, { userId: foreignUser!.id, organizationId: foreignOrg!.id })
    expect([...foreignCtx!.authz.permissions]).toEqual(['booking.view'])
    expect((await authenticate(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_PASSWORD))?.user.id).toBe(demoIds.user('admin'))
    expect((await authenticate('foreign-org', DEMO_ADMIN_EMAIL, 'foreign-org-password'))?.user.id).toBe(foreignUser!.id)
  })
})
