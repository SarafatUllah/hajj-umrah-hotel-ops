import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { asc, eq, sql } from 'drizzle-orm'
import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { appUser, organization, role } from '../../../db/schema'
import type { DbOrTx } from '../../../db/client'
import { HotelQuery, OrgQuery } from '../../../server/repositories/base/scopedQuery'
import { trustedHotelScope, trustedOrganizationScope, type OrganizationScope } from '../../../server/security/scope'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

async function makeOrgScope(slug: string): Promise<OrganizationScope> {
  const [org] = await db.insert(organization).values({ name: slug, slug }).returning()
  return trustedOrganizationScope(org!.id)
}

/** Two organizations with identical shapes: the same user email and the same role key in each. */
async function twoIdenticalOrgs() {
  const scopeA = await makeOrgScope('org-a')
  const scopeB = await makeOrgScope('org-b')
  for (const scope of [scopeA, scopeB]) {
    await db.insert(appUser).values({ organizationId: scope.organizationId, email: 'same@example.test', passwordHash: 'x', fullName: 'Original' })
    await db.insert(role).values({ organizationId: scope.organizationId, key: 'SAME', name: 'Same' })
  }
  return { scopeA, scopeB }
}

describe('OrgQuery', () => {
  it('insert ignores an organizationId smuggled in with a cast and stores the scope organization', async () => {
    const { scopeA, scopeB } = await twoIdenticalOrgs()

    const [inserted] = await new OrgQuery(db, scopeA)
      .insert(appUser, { organizationId: scopeB.organizationId, email: 'smuggled@example.test', passwordHash: 'x', fullName: 'S' } as never)
      .returning()

    expect(inserted!.organizationId).toBe(scopeA.organizationId)
    const inB = await db.select().from(appUser).where(eq(appUser.email, 'smuggled@example.test'))
    expect(inB.map(r => r.organizationId)).toEqual([scopeA.organizationId])
  })

  it('select returns only rows of the scope organization', async () => {
    const { scopeA } = await twoIdenticalOrgs()

    const rows = await new OrgQuery(db, scopeA).select(appUser, eq(appUser.email, 'same@example.test'))

    expect(rows.map(r => r.organizationId)).toEqual([scopeA.organizationId])
    // Without an extra predicate the organization predicate still applies.
    expect((await new OrgQuery(db, scopeA).select(role)).map(r => r.organizationId)).toEqual([scopeA.organizationId])
  })

  it('select honours orderBy, limit and offset', async () => {
    const { scopeA } = await twoIdenticalOrgs()
    await db.insert(role).values([
      { organizationId: scopeA.organizationId, key: 'A1', name: 'a1' },
      { organizationId: scopeA.organizationId, key: 'A2', name: 'a2' },
    ])

    const rows = await new OrgQuery(db, scopeA).select(role, undefined, { orderBy: [asc(role.key)], limit: 2, offset: 1 })

    expect(rows.map(r => r.key)).toEqual(['A2', 'SAME'])
  })

  it('update never touches another organization\'s rows', async () => {
    const { scopeA, scopeB } = await twoIdenticalOrgs()

    const result = await new OrgQuery(db, scopeA).update(appUser, { fullName: 'Changed' }, eq(appUser.email, 'same@example.test')).returning()

    expect(result.map(r => r.organizationId)).toEqual([scopeA.organizationId])
    const [bUser] = await db.select().from(appUser).where(eq(appUser.organizationId, scopeB.organizationId))
    expect(bUser!.fullName).toBe('Original')
  })

  it('update ignores an organizationId smuggled into set with a cast: the row cannot move to another organization', async () => {
    const { scopeA, scopeB } = await twoIdenticalOrgs()

    const updated = await new OrgQuery(db, scopeA)
      .update(role, { organizationId: scopeB.organizationId, name: 'Renamed' } as never, eq(role.key, 'SAME'))
      .returning()

    expect(updated.map(r => [r.organizationId, r.name])).toEqual([[scopeA.organizationId, 'Renamed']])
    const rows = await db.select().from(role).orderBy(asc(role.name))
    expect(rows.map(r => [r.organizationId, r.name])).toEqual([[scopeA.organizationId, 'Renamed'], [scopeB.organizationId, 'Same']])
  })

  it('delete never touches another organization\'s rows', async () => {
    const { scopeA, scopeB } = await twoIdenticalOrgs()

    await new OrgQuery(db, scopeA).delete(role, eq(role.key, 'SAME'))

    const remaining = await db.select().from(role)
    expect(remaining.map(r => r.organizationId)).toEqual([scopeB.organizationId])
  })

  it('cond combines the organization predicate with every extra predicate', async () => {
    const { scopeA } = await twoIdenticalOrgs()
    const q = new OrgQuery(db, scopeA)

    const rows = await db.select().from(role).where(q.cond(role, eq(role.key, 'SAME'), undefined))
    expect(rows.map(r => r.organizationId)).toEqual([scopeA.organizationId])
    expect(await db.select().from(role).where(q.cond(role, eq(role.key, 'NOPE')))).toEqual([])
  })
})

// No hotel-owned table exists before Task 6, so HotelQuery is exercised against a
// temporary table with the same (organization_id, hotel_id) shape, created inside a
// transaction (temporary tables are per-connection) that is rolled back afterwards.
const hotelProbe = pgTable('hotel_query_probe', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  hotelId: uuid('hotel_id').notNull(),
  label: text('label').notNull(),
})

class Rollback extends Error {}

async function withProbeTable(fn: (tx: DbOrTx) => Promise<void>) {
  await expect(db.transaction(async (tx) => {
    await tx.execute(sql`CREATE TEMPORARY TABLE hotel_query_probe (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      hotel_id uuid NOT NULL,
      label text NOT NULL
    ) ON COMMIT DROP`)
    await fn(tx)
    throw new Rollback()
  })).rejects.toBeInstanceOf(Rollback)
}

describe('HotelQuery', () => {
  const orgA = '00000000-0000-4000-8000-00000000000a'
  const orgB = '00000000-0000-4000-8000-00000000000b'
  const hotel1 = '00000000-0000-4000-8000-000000000001'
  const hotel2 = '00000000-0000-4000-8000-000000000002'
  const scopeA1 = trustedHotelScope(trustedOrganizationScope(orgA), hotel1)

  async function seedProbe(tx: DbOrTx) {
    // Same hotel id under a different organization, and another hotel in the same organization.
    await tx.insert(hotelProbe).values([
      { organizationId: orgA, hotelId: hotel1, label: 'a1' },
      { organizationId: orgA, hotelId: hotel2, label: 'a2' },
      { organizationId: orgB, hotelId: hotel1, label: 'b1' },
    ])
  }

  it('select requires both the organization and the hotel predicate', async () => {
    await withProbeTable(async (tx) => {
      await seedProbe(tx)
      const rows = await new HotelQuery(tx, scopeA1).select(hotelProbe)
      expect(rows.map(r => r.label)).toEqual(['a1'])
    })
  })

  it('insert ignores a smuggled organizationId and hotelId', async () => {
    await withProbeTable(async (tx) => {
      const [row] = await new HotelQuery(tx, scopeA1)
        .insert(hotelProbe, { organizationId: orgB, hotelId: hotel2, label: 'new' } as never)
        .returning()
      expect(row).toMatchObject({ organizationId: orgA, hotelId: hotel1, label: 'new' })
    })
  })

  it('update ignores a smuggled organizationId and hotelId: the row cannot move to another hotel or organization', async () => {
    await withProbeTable(async (tx) => {
      await seedProbe(tx)
      const q = new HotelQuery(tx, scopeA1)

      const toOtherHotel = await q.update(hotelProbe, { hotelId: hotel2, label: 'moved?' } as never).returning()
      expect(toOtherHotel.map(r => [r.organizationId, r.hotelId, r.label])).toEqual([[orgA, hotel1, 'moved?']])

      const toOtherOrg = await q.update(hotelProbe, { organizationId: orgB, hotelId: hotel2 } as never).returning()
      expect(toOtherOrg.map(r => [r.organizationId, r.hotelId])).toEqual([[orgA, hotel1]])

      const all = await tx.select().from(hotelProbe).orderBy(asc(hotelProbe.label))
      expect(all.map(r => [r.organizationId, r.hotelId, r.label])).toEqual([
        [orgA, hotel2, 'a2'],
        [orgB, hotel1, 'b1'],
        [orgA, hotel1, 'moved?'],
      ])
    })
  })

  it('update and delete touch only the scope hotel inside the scope organization', async () => {
    await withProbeTable(async (tx) => {
      await seedProbe(tx)
      const q = new HotelQuery(tx, scopeA1)

      const updated = await q.update(hotelProbe, { label: 'changed' }).returning()
      expect(updated.map(r => [r.organizationId, r.hotelId])).toEqual([[orgA, hotel1]])

      await q.delete(hotelProbe)
      const left = await tx.select().from(hotelProbe).orderBy(asc(hotelProbe.label))
      expect(left.map(r => r.label)).toEqual(['a2', 'b1'])
    })
  })
})
