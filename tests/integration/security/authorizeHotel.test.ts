import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../../../db/client'
import { NotFoundError } from '../../../server/errors/domainError'
import { authorizeHotel } from '../../../server/security/authorize'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import type { Permission } from '../../../shared/constants/permissions'
import { makeHotel, makeOrg } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

function makeCtx(scope: OrganizationScope, opts: { permissions?: Permission[], allHotels?: boolean, hotelIds?: string[] } = {}): AuthContext {
  return {
    identity: { userId: '00000000-0000-0000-0000-0000000000aa', organizationId: scope.organizationId, email: 'caller@test.com', fullName: 'Caller' },
    authz: {
      permissions: new Set(opts.permissions ?? []),
      allHotels: opts.allHotels ?? false,
      hotelIds: new Set(opts.hotelIds ?? []),
    },
    scope,
    db: db as Database,
    now: () => new Date(),
  }
}

describe('authorizeHotel', () => {
  it('foreign-org hotel -> NotFoundError(HOTEL_NOT_FOUND)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const hotelRow = await makeHotel(db, orgA)
    const ctx = makeCtx(orgB, { permissions: ['hotel.view'], allHotels: true })

    await expect(authorizeHotel(ctx, 'hotel.view', hotelRow.id)).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND', httpStatus: 404 })
  })

  it('same-org hotel the caller has no access to -> the IDENTICAL NotFoundError as a foreign-org hotel', async () => {
    const { scope: org } = await makeOrg(db)
    const { scope: otherOrg } = await makeOrg(db)
    const foreignHotel = await makeHotel(db, otherOrg)
    const ownHotel = await makeHotel(db, org)

    const ctxNoAccess = makeCtx(org, { permissions: ['hotel.view'], hotelIds: [] })

    let foreignError: unknown
    let noAccessError: unknown
    try {
      await authorizeHotel(makeCtx(org, { permissions: ['hotel.view'] }), 'hotel.view', foreignHotel.id)
    }
    catch (e) { foreignError = e }
    try {
      await authorizeHotel(ctxNoAccess, 'hotel.view', ownHotel.id)
    }
    catch (e) { noAccessError = e }

    expect(foreignError).toBeInstanceOf(NotFoundError)
    expect(noAccessError).toBeInstanceOf(NotFoundError)
    expect((foreignError as NotFoundError).code).toBe((noAccessError as NotFoundError).code)
    expect((foreignError as NotFoundError).httpStatus).toBe((noAccessError as NotFoundError).httpStatus)
    expect((noAccessError as NotFoundError).code).toBe('HOTEL_NOT_FOUND')
  })

  it('accessible hotel but missing permission -> ForbiddenError(FORBIDDEN)', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelRow = await makeHotel(db, org)
    const ctx = makeCtx(org, { permissions: [], hotelIds: [hotelRow.id] })

    await expect(authorizeHotel(ctx, 'hotel.view', hotelRow.id)).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 })
  })

  it('allHotels grants access to any hotel in the caller\'s own organization', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelRow = await makeHotel(db, org)
    const ctx = makeCtx(org, { permissions: ['hotel.view'], allHotels: true })

    const result = await authorizeHotel(ctx, 'hotel.view', hotelRow.id)
    expect(result.hotel.id).toBe(hotelRow.id)
  })

  it('inactive hotel: a write (no allowInactive) -> ConflictError(HOTEL_INACTIVE)', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelRow = await makeHotel(db, org, { status: 'INACTIVE' })
    const ctx = makeCtx(org, { permissions: ['hotel.manage'], hotelIds: [hotelRow.id] })

    await expect(authorizeHotel(ctx, 'hotel.manage', hotelRow.id)).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
  })

  it('inactive hotel: a read with allowInactive -> succeeds', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelRow = await makeHotel(db, org, { status: 'INACTIVE' })
    const ctx = makeCtx(org, { permissions: ['hotel.view'], hotelIds: [hotelRow.id] })

    const result = await authorizeHotel(ctx, 'hotel.view', hotelRow.id, { allowInactive: true })
    expect(result.hotel.id).toBe(hotelRow.id)
  })

  it('the returned scope\'s hotelId equals the resolved hotel\'s id', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelRow = await makeHotel(db, org)
    const ctx = makeCtx(org, { permissions: ['hotel.view'], allHotels: true })

    const result = await authorizeHotel(ctx, 'hotel.view', hotelRow.id)
    expect(result.scope.hotelId).toBe(hotelRow.id)
    expect(result.scope.organizationId).toBe(org.organizationId)
  })
})
