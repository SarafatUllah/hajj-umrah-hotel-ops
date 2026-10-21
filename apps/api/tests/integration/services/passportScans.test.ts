import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { agencyUser, bookingGuest, bookingSetting, documentAsset, passportScan, piiAccessLog } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { holdRequestSchema } from '@hajj/contracts/schemas/booking'
import { setPassportReadersForTests } from '../../../server/integrations/passportReaders'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { agencyScanImage, confirmAgencyScan, discardAgencyScan, holdAgencyStay, listAgencyGuests, listAgencyScans, listScans, purgeExpiredPassportImages, readPassportScan, scanImage, setPassportReadQueue, uploadAgencyScan } from '../../../server/services/booking'
import { getStorageDriver, resetStorageDriverCache } from '../../../server/storage'
import { makeAgency } from '../../support/bookingFixtures'
import { makeOrg, makeUser } from '../../support/fixtures'
import { td3 } from '../../support/mrz'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const NOW = new Date('2027-05-01T10:00:00Z')
// A 1×1 PNG (the upload check reads the file's own signature).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const queued: Array<{ organizationId: string, scanId: string }> = []
let storageDir = ''

beforeAll(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'passport-scans-'))
  process.env.STORAGE_LOCAL_DIR = storageDir
  resetStorageDriverCache()
})

beforeEach(() => {
  queued.length = 0
  setPassportReadQueue(async (_tx, data) => { queued.push(data) })
})

afterEach(async () => {
  setPassportReadersForTests(null)
  await truncateAllTables()
})

afterAll(async () => {
  setPassportReadQueue(null)
  resetStorageDriverCache()
  rmSync(storageDir, { recursive: true, force: true })
  await closeTestDb()
})

async function agencyCtx(scope: OrganizationScope, agencyId: string): Promise<AgencyContext> {
  const [user] = await db.insert(agencyUser).values({ organizationId: scope.organizationId, agencyId, email: `u-${agencyId}@example.test`, passwordHash: 'h', fullName: 'Agent' }).returning()
  return (await resolveAgencyContext(db, { agencyUserId: user!.id, organizationId: scope.organizationId, agencyId }, () => NOW))!
}

/** Two men (Quad 101), a woman (Double 201). Slots 1–2 men, 3 woman. */
async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel, rooms } = await makeStayHotel(db, scope)
  const agency = await agencyCtx(scope, (await makeAgency(db, scope)).id)
  const held = await holdAgencyStay(agency, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, femaleCount: 1, totalCount: 3,
    rooms: [{ roomId: rooms['101'], occupancy: 'MALE', seats: 2 }, { roomId: rooms['201'], occupancy: 'FEMALE', seats: 1 }],
  }))
  const slots = await listAgencyGuests(agency, held.id)
  return { scope, agency, bookingId: held.id, slots }
}

function staff(scope: OrganizationScope, userId: string, permissions: Permission[]): AuthContext {
  return { identity: { userId, organizationId: scope.organizationId, email: 's@example.test', fullName: 'Staff' }, authz: { permissions: new Set(permissions), allHotels: true, hotelIds: new Set() }, scope, db, now: () => NOW }
}

/** A PNG header declaring `width × height` (enough for the upload check, which never decodes the image). */
function pngDeclaring(width: number, height: number): Buffer {
  const header = Buffer.from(PNG.subarray(0, 33))
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

const scanRow = async (scanId: string) => (await db.select().from(passportScan).where(eq(passportScan.id, scanId)))[0]!
const assetOf = async (scanId: string) => (await db.select().from(documentAsset).where(eq(documentAsset.id, (await scanRow(scanId)).documentId)))[0]!

const ocrReading = (lines: [string, string]) => ({ ocr: { readText: async () => `PASSPORT\n${lines.join('\n')}` }, vision: null })
const upload = (ctx: AgencyContext, bookingId: string) => uploadAgencyScan(ctx, bookingId, { bytes: PNG, mimeType: 'image/png', filename: 'passport.png' })

describe('passport scans (v7 §13, ticket 1)', () => {
  it('upload → encrypted image, QUEUED, reading enqueued; the reading fills the review card and picks the slot of the passport\'s gender', async () => {
    const env = await setup()
    const scan = await upload(env.agency, env.bookingId)
    expect(scan).toMatchObject({ status: 'QUEUED', fields: null })
    expect(queued).toEqual([{ organizationId: env.scope.organizationId, scanId: scan.id }])
    const [asset] = await db.select().from(documentAsset)
    const stored = await getStorageDriver().get(asset!.storageKey)
    const chunks: Buffer[] = []
    for await (const chunk of stored) chunks.push(Buffer.from(chunk as Uint8Array))
    expect(Buffer.concat(chunks).includes(PNG.subarray(8, 24))).toBe(false)

    setPassportReadersForTests(ocrReading(td3('KARIM', 'MD', 'A1234567', 'BGD', '800101', 'M', '320101')))
    await readPassportScan(db, env.scope.organizationId, scan.id, NOW)
    await readPassportScan(db, env.scope.organizationId, scan.id, NOW) // idempotent
    const [card] = await listAgencyScans(env.agency, env.bookingId)
    expect(card).toMatchObject({ status: 'NEEDS_REVIEW', method: 'MRZ', guestId: env.slots[0]!.id, fields: { fullName: 'MD KARIM', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-01-01', passportNo: 'A1234567', passportExpiry: '2032-01-01' } })
    expect(card!.needsAttention).toEqual(['fullName'])
    expect((await db.select().from(passportScan))[0]!.extractedEncrypted).not.toContain('KARIM')
    expect(await db.select().from(piiAccessLog).where(eq(piiAccessLog.subjectType, 'PASSPORT_SCAN'))).toHaveLength(1)
  })

  it('confirming the review form fills the slot (READY) and points the scan at the booker\'s copy', async () => {
    const env = await setup()
    setPassportReadersForTests(ocrReading(td3('KARIM', 'MD', 'A1234567', 'BGD', '800101', 'M', '320101')))
    const scan = await upload(env.agency, env.bookingId)
    await readPassportScan(db, env.scope.organizationId, scan.id, NOW)
    const [card] = await listAgencyScans(env.agency, env.bookingId)
    const slot = await confirmAgencyScan(env.agency, env.bookingId, scan.id, { guestId: card!.guestId!, details: { ...card!.fields, fullName: 'Md. Karim' } })
    expect(slot).toMatchObject({ status: 'READY', details: { fullName: 'Md. Karim', passportNo: '•••567' } })
    const [row] = await db.select().from(passportScan)
    expect(row).toMatchObject({ status: 'CONFIRMED', bookingGuestId: card!.guestId, reviewedByKind: 'agency' })
    expect(row!.bookingGuestDetailId).not.toBeNull()
    await expect(confirmAgencyScan(env.agency, env.bookingId, scan.id, { guestId: card!.guestId!, details: card!.fields })).rejects.toMatchObject({ code: 'SCAN_NOT_OPEN' })
    // The same rules as a hand entry: a man's passport is refused for the women's slot.
    const second = await upload(env.agency, env.bookingId)
    await readPassportScan(db, env.scope.organizationId, second.id, NOW)
    const woman = env.slots.find(s => s.gender === 'FEMALE')!
    await expect(confirmAgencyScan(env.agency, env.bookingId, second.id, { guestId: woman.id, details: { ...card!.fields, passportNo: 'B7654321' } })).rejects.toMatchObject({ code: 'GUEST_DETAILS_REJECTED' })
  })

  it('nothing to read with (no OCR, no AI): FAILED for manual entry; a discarded scan loses its image; PDFs and other agencies are refused', async () => {
    const env = await setup()
    const scan = await upload(env.agency, env.bookingId)
    await readPassportScan(db, env.scope.organizationId, scan.id, NOW)
    expect((await listAgencyScans(env.agency, env.bookingId))[0]).toMatchObject({ status: 'FAILED', failureReason: 'NO_READER', fields: null })

    expect((await agencyScanImage(env.agency, env.bookingId, scan.id)).bytes.equals(PNG)).toBe(true)
    const [asset] = await db.select().from(documentAsset)
    expect(await discardAgencyScan(env.agency, env.bookingId, scan.id)).toMatchObject({ status: 'DISCARDED' })
    expect(await getStorageDriver().exists(asset!.storageKey)).toBe(false)
    await expect(agencyScanImage(env.agency, env.bookingId, scan.id)).rejects.toMatchObject({ code: 'SCAN_NOT_FOUND', httpStatus: 404 })
    expect(await scanRow(scan.id)).toMatchObject({ deleteAfter: '2027-05-01', extractedEncrypted: null })
    expect((await assetOf(scan.id)).archivedAt).not.toBeNull()

    await expect(uploadAgencyScan(env.agency, env.bookingId, { bytes: Buffer.from('%PDF-1.4\n%âãÏÓ\n'), mimeType: 'application/pdf', filename: 'p.pdf' })).rejects.toMatchObject({ httpStatus: 422 })
    const other = await agencyCtx(env.scope, (await makeAgency(db, env.scope)).id)
    await expect(listAgencyScans(other, env.bookingId)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', httpStatus: 404 })
    expect(await db.select().from(bookingGuest).where(eq(bookingGuest.status, 'READY'))).toEqual([])
  })

  it('uploads are refused when the image declares too many pixels, or when every pilgrim already has a scan waiting (plus 5 re-takes)', async () => {
    const env = await setup()
    await expect(uploadAgencyScan(env.agency, env.bookingId, { bytes: pngDeclaring(10_000, 10_000), mimeType: 'image/png', filename: 'huge.png' })).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE', httpStatus: 422 })
    const scans = []
    for (let i = 0; i < 8; i++) scans.push(await upload(env.agency, env.bookingId))
    await expect(upload(env.agency, env.bookingId)).rejects.toMatchObject({ code: 'TOO_MANY_SCANS', httpStatus: 409 })
    expect(await db.select().from(documentAsset)).toHaveLength(8)
    await discardAgencyScan(env.agency, env.bookingId, scans[0]!.id)
    await expect(upload(env.agency, env.bookingId)).resolves.toMatchObject({ status: 'QUEUED' })
  })

  it('a reading that throws ends FAILED (READ_ERROR) instead of staying PROCESSING; a reading that crashed long ago is taken over', async () => {
    const env = await setup()
    const lost = await upload(env.agency, env.bookingId)
    await getStorageDriver().delete((await assetOf(lost.id)).storageKey)
    await readPassportScan(db, env.scope.organizationId, lost.id, NOW)
    expect(await scanRow(lost.id)).toMatchObject({ status: 'FAILED', failureReason: 'READ_ERROR' })

    const crashed = await upload(env.agency, env.bookingId)
    await db.update(passportScan).set({ status: 'PROCESSING', updatedAt: new Date(NOW.getTime() - 5 * 60_000) }).where(eq(passportScan.id, crashed.id))
    await readPassportScan(db, env.scope.organizationId, crashed.id, NOW)
    expect(await scanRow(crashed.id)).toMatchObject({ status: 'PROCESSING' })
    await db.update(passportScan).set({ updatedAt: new Date(NOW.getTime() - 11 * 60_000) }).where(eq(passportScan.id, crashed.id))
    await readPassportScan(db, env.scope.organizationId, crashed.id, NOW)
    expect(await scanRow(crashed.id)).toMatchObject({ status: 'FAILED', failureReason: 'NO_READER' })

    // A reading that died for good can still be thrown away (it would otherwise block the booking's quota of scans).
    const dead = await upload(env.agency, env.bookingId)
    await db.update(passportScan).set({ status: 'PROCESSING', updatedAt: new Date(NOW.getTime() - 5 * 60_000) }).where(eq(passportScan.id, dead.id))
    await expect(discardAgencyScan(env.agency, env.bookingId, dead.id)).rejects.toMatchObject({ code: 'SCAN_NOT_OPEN' })
    await db.update(passportScan).set({ updatedAt: new Date(NOW.getTime() - 11 * 60_000) }).where(eq(passportScan.id, dead.id))
    expect(await discardAgencyScan(env.agency, env.bookingId, dead.id)).toMatchObject({ status: 'DISCARDED' })

    // A reading that cannot be decrypted is reported on its own card; the other cards still show.
    await db.update(passportScan).set({ extractedEncrypted: 'not-a-ciphertext' }).where(eq(passportScan.id, lost.id))
    const cards = await listAgencyScans(env.agency, env.bookingId)
    expect(cards.find(c => c.id === lost.id)).toMatchObject({ fields: null, failureReason: 'UNREADABLE_RECORD' })
    expect(cards).toHaveLength(3)
  })

  it('the external AI reader reads only with the organization\'s consent, and each sending is logged as a disclosure', async () => {
    const env = await setup()
    let calls = 0
    setPassportReadersForTests({ ocr: null, vision: { maxImageBytes: 5 * 1024 * 1024, readFields: async () => { calls++; return { fullName: 'MD KARIM', gender: 'MALE', dateOfBirth: '1980-01-01' } } } })
    const withoutConsent = await upload(env.agency, env.bookingId)
    await readPassportScan(db, env.scope.organizationId, withoutConsent.id, NOW)
    expect(await scanRow(withoutConsent.id)).toMatchObject({ status: 'FAILED', failureReason: 'NO_READER' })
    expect(calls).toBe(0)

    await db.update(bookingSetting).set({ passportAiAllowed: true }).where(eq(bookingSetting.organizationId, env.scope.organizationId))
    const withConsent = await upload(env.agency, env.bookingId)
    await readPassportScan(db, env.scope.organizationId, withConsent.id, NOW)
    expect(calls).toBe(1)
    const card = (await listAgencyScans(env.agency, env.bookingId)).find(c => c.id === withConsent.id)
    expect(card).toMatchObject({ status: 'NEEDS_REVIEW', method: 'AI', guestId: env.slots[0]!.id, fields: { fullName: 'MD KARIM' }, needsAttention: ['fullName', 'gender', 'nationality', 'dateOfBirth', 'passportNo', 'passportExpiry'] })
    expect(await db.select().from(piiAccessLog).where(eq(piiAccessLog.actorKind, 'system'))).toMatchObject([{ subjectId: withConsent.id, fields: ['image'], purpose: 'sent to the external AI reader' }])
  })

  it('the daily retention sweep deletes images past their retention, and the reading taken from them', async () => {
    const env = await setup()
    setPassportReadersForTests(ocrReading(td3('KARIM', 'MD', 'A1234567', 'BGD', '800101', 'M', '320101')))
    const [expired, kept] = [await upload(env.agency, env.bookingId), await upload(env.agency, env.bookingId)]
    for (const scan of [expired, kept]) await readPassportScan(db, env.scope.organizationId, scan.id, NOW)
    expect(await scanRow(kept.id)).toMatchObject({ deleteAfter: '2028-06-04' })
    await db.update(passportScan).set({ deleteAfter: '2027-04-30' }).where(eq(passportScan.id, expired.id))

    expect(await purgeExpiredPassportImages(db, [env.scope], NOW)).toBe(1)
    expect(await getStorageDriver().exists((await assetOf(expired.id)).storageKey)).toBe(false)
    expect(await scanRow(expired.id)).toMatchObject({ status: 'NEEDS_REVIEW', extractedEncrypted: null })
    expect(await getStorageDriver().exists((await assetOf(kept.id)).storageKey)).toBe(true)
    await expect(agencyScanImage(env.agency, env.bookingId, expired.id)).rejects.toMatchObject({ code: 'SCAN_NOT_FOUND' })
    expect(await purgeExpiredPassportImages(db, [env.scope], NOW)).toBe(0)
  })

  it('staff with booking.edit upload and confirm; reviewing what was read also needs pilgrim.viewSensitive', async () => {
    const env = await setup()
    const scan = await upload(env.agency, env.bookingId)
    const reception = staff(env.scope, (await makeUser(db, env.scope)).id, ['booking.view', 'booking.edit', 'pilgrim.view'])
    const manager = staff(env.scope, (await makeUser(db, env.scope)).id, ['booking.view', 'booking.edit', 'pilgrim.view', 'pilgrim.viewSensitive'])
    await expect(listScans(reception, env.bookingId)).rejects.toMatchObject({ httpStatus: 403 })
    await expect(scanImage(reception, env.bookingId, scan.id)).rejects.toMatchObject({ httpStatus: 403 })
    expect(await listScans(manager, env.bookingId)).toMatchObject([{ id: scan.id, status: 'QUEUED' }])
    expect((await scanImage(manager, env.bookingId, scan.id)).bytes.equals(PNG)).toBe(true)
  })
})
