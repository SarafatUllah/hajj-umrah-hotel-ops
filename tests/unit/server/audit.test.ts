import { describe, expect, it, vi } from 'vitest'
import { recordAudit } from '../../../server/services/audit'
import type { AuditRepository, NewAuditEntry } from '../../../server/repositories/tenant/auditRepository'

function fakeAuditRepository() {
  const record = vi.fn<(entry: NewAuditEntry) => Promise<void>>().mockResolvedValue(undefined)
  return { record: record as unknown as AuditRepository['record'], calls: record.mock.calls }
}

describe('recordAudit', () => {
  it('writes hotelId, actorUserId, entityType, entityId, action, and defaults reason to null', async () => {
    const repo = fakeAuditRepository()

    await recordAudit(repo as unknown as AuditRepository, 'actor-1', {
      hotelId: 'hotel-1',
      entityType: 'hotel',
      entityId: 'hotel-1',
      action: 'HOTEL_CREATED',
    })

    expect(repo.calls[0]?.[0]).toMatchObject({
      hotelId: 'hotel-1',
      actorUserId: 'actor-1',
      entityType: 'hotel',
      entityId: 'hotel-1',
      action: 'HOTEL_CREATED',
      reason: null,
      beforeData: null,
      afterData: null,
    })
  })

  it('defaults hotelId to null when omitted (organization-level entry)', async () => {
    const repo = fakeAuditRepository()

    await recordAudit(repo as unknown as AuditRepository, 'actor-1', {
      entityType: 'organization',
      entityId: 'org-1',
      action: 'DEMO_RESET',
    })

    expect(repo.calls[0]?.[0]?.hotelId).toBeNull()
  })

  it('redacts a top-level passwordHash', async () => {
    const repo = fakeAuditRepository()

    await recordAudit(repo as unknown as AuditRepository, 'actor-1', {
      entityType: 'user', entityId: 'user-1', action: 'HOTEL_CREATED',
      before: { email: 'a@example.test', passwordHash: 'super-secret' },
    })

    expect(repo.calls[0]?.[0]?.beforeData).toEqual({ email: 'a@example.test' })
  })

  it('redacts password/token/secret keys nested at any depth, in objects and arrays', async () => {
    const repo = fakeAuditRepository()

    await recordAudit(repo as unknown as AuditRepository, 'actor-1', {
      entityType: 'user', entityId: 'user-1', action: 'HOTEL_UPDATED',
      after: {
        user: { fullName: 'A User', password: 'x', password_hash: 'y', nested: { token: 'z', secret: 'w', keep: 'kept' } },
        grants: [{ userId: 'u1', token: 'array-secret', keep: 'yes' }],
      },
    })

    expect(repo.calls[0]?.[0]?.afterData).toEqual({
      user: { fullName: 'A User', nested: { keep: 'kept' } },
      grants: [{ userId: 'u1', keep: 'yes' }],
    })
  })

  it('converts undefined values to null instead of dropping the key', async () => {
    const repo = fakeAuditRepository()

    await recordAudit(repo as unknown as AuditRepository, 'actor-1', {
      entityType: 'hotel', entityId: 'hotel-1', action: 'HOTEL_UPDATED',
      before: { name: 'Hotel', notes: undefined },
    })

    expect(repo.calls[0]?.[0]?.beforeData).toEqual({ name: 'Hotel', notes: null })
  })

  it('a Date value survives the JSON round-trip as an ISO string', async () => {
    const repo = fakeAuditRepository()
    const when = new Date('2026-01-15T10:30:00.000Z')

    await recordAudit(repo as unknown as AuditRepository, 'actor-1', {
      entityType: 'hotel', entityId: 'hotel-1', action: 'HOTEL_UPDATED',
      before: { archivedAt: when },
    })

    expect(repo.calls[0]?.[0]?.beforeData).toEqual({ archivedAt: '2026-01-15T10:30:00.000Z' })
  })

  it('a BigInt value cannot break the insert (stringified instead of throwing)', async () => {
    const repo = fakeAuditRepository()

    await expect(recordAudit(repo as unknown as AuditRepository, 'actor-1', {
      entityType: 'hotel', entityId: 'hotel-1', action: 'HOTEL_UPDATED',
      before: { sequence: 9007199254740993n },
    })).resolves.toBeUndefined()

    expect(repo.calls[0]?.[0]?.beforeData).toEqual({ sequence: '9007199254740993' })
  })

  it('leaves before/after as null when omitted entirely', async () => {
    const repo = fakeAuditRepository()

    await recordAudit(repo as unknown as AuditRepository, 'actor-1', { entityType: 'hotel', entityId: 'hotel-1', action: 'HOTEL_CREATED' })

    expect(repo.calls[0]?.[0]?.beforeData).toBeNull()
    expect(repo.calls[0]?.[0]?.afterData).toBeNull()
  })
})
