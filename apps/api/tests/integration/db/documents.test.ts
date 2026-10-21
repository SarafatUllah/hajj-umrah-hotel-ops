import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { documentAsset, hotelDocument } from '../../../db/schema'
import { extractPgError, translateDbError } from '../../../server/errors/dbErrors'
import { ValidationError } from '../../../server/errors/domainError'
import { platformRepos } from '../../../server/repositories'
import { trustedHotelScope } from '../../../server/security/scope'
import { makeHotel, makeHotelDocument, makeOrg } from '../../support/fixtures'
import { closeTestDb, getTestClient, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return undefined
  }
  catch (error) {
    return error
  }
}

const pgCode = async (fn: () => Promise<unknown>) => extractPgError(await catchError(fn))?.code
const pgConstraint = async (fn: () => Promise<unknown>) => extractPgError(await catchError(fn))?.constraint

async function setup() {
  const { organization, scope: orgScope } = await makeOrg(db)
  const hotelRow = await makeHotel(db, orgScope)
  return { organization, orgScope, hotelRow, scope: trustedHotelScope(orgScope, hotelRow.id) }
}

const assetValues = (organizationId: string, overrides: Partial<typeof documentAsset.$inferInsert> = {}): typeof documentAsset.$inferInsert => ({
  organizationId,
  storageKey: `${organizationId}/2026/${crypto.randomUUID()}.pdf`,
  originalFilename: 'a.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 100,
  sha256: 'b'.repeat(64),
  ...overrides,
})

describe('document_asset: check constraints', () => {
  it.each(['application/pdf', 'image/png', 'image/jpeg'])('accepts mime %s', async (mimeType) => {
    const { organization } = await setup()
    await expect(db.insert(documentAsset).values(assetValues(organization.id, { mimeType }))).resolves.toBeDefined()
  })

  it.each(['image/svg+xml', 'text/html', 'application/x-msdownload', 'IMAGE/PNG', ''])('rejects mime %j (23514, document_asset_mime_check)', async (mimeType) => {
    const { organization } = await setup()
    const error = await catchError(() => db.insert(documentAsset).values(assetValues(organization.id, { mimeType })))
    expect(extractPgError(error)).toMatchObject({ code: '23514', constraint: 'document_asset_mime_check' })
    const translated = translateDbError(error)
    expect(translated).toBeInstanceOf(ValidationError)
    expect(translated?.code).toBe('CONSTRAINT_VIOLATION')
  })

  it('accepts sizes 1 and 10485760 and rejects 0, -1 and 10485761 (document_asset_size_check)', async () => {
    const { organization } = await setup()
    await expect(db.insert(documentAsset).values(assetValues(organization.id, { sizeBytes: 1 }))).resolves.toBeDefined()
    await expect(db.insert(documentAsset).values(assetValues(organization.id, { sizeBytes: 10_485_760 }))).resolves.toBeDefined()
    for (const sizeBytes of [0, -1, 10_485_761]) {
      expect(await pgConstraint(() => db.insert(documentAsset).values(assetValues(organization.id, { sizeBytes })))).toBe('document_asset_size_check')
    }
  })

  it('rejects a duplicate storage_key (23505, document_asset_storage_key_unique) even across organizations', async () => {
    const a = await setup()
    const b = await setup()
    const row = assetValues(a.organization.id)
    await db.insert(documentAsset).values(row)
    expect(await pgConstraint(() => db.insert(documentAsset).values({ ...assetValues(a.organization.id), storageKey: row.storageKey }))).toBe('document_asset_storage_key_unique')
    expect(await pgCode(() => db.insert(documentAsset).values({ ...assetValues(b.organization.id), storageKey: row.storageKey }))).toBe('23505')
  })

  it('requires the organization to exist (23503)', async () => {
    expect(await pgCode(() => db.insert(documentAsset).values(assetValues(crypto.randomUUID())))).toBe('23503')
  })
})

describe('hotel_document: constraints', () => {
  it.each(['LICENSE', 'CONTRACT', 'INSURANCE', 'PERMIT', 'OTHER'])('accepts doc_type %s', async (docType) => {
    const { scope } = await setup()
    await expect(makeHotelDocument(db, scope, { docType })).resolves.toBeDefined()
  })

  it.each(['license', 'INVOICE', ''])('rejects doc_type %j (hotel_document_type_check)', async (docType) => {
    const { scope } = await setup()
    expect(await pgConstraint(() => makeHotelDocument(db, scope, { docType }))).toBe('hotel_document_type_check')
  })

  it('rejects a hotel_document whose hotel belongs to another organization (23503, hotel_document_hotel_fk)', async () => {
    const a = await setup()
    const b = await setup()
    const asset = await makeHotelDocument(db, a.scope)
    const planted = assetValues(a.organization.id)
    const [plantedAsset] = await db.insert(documentAsset).values(planted).returning()
    // org A's asset + org A as organization_id, but org B's hotel
    expect(await pgConstraint(() => db.insert(hotelDocument).values({ documentId: plantedAsset!.id, organizationId: a.organization.id, hotelId: b.hotelRow.id, docType: 'LICENSE', title: 't' }))).toBe('hotel_document_hotel_fk')
    expect(asset.document.hotelId).toBe(a.hotelRow.id)
  })

  it('rejects a hotel_document whose asset belongs to another organization (23503, hotel_document_asset_fk)', async () => {
    const a = await setup()
    const b = await setup()
    const [assetB] = await db.insert(documentAsset).values(assetValues(b.organization.id)).returning()
    // organization A + A's own hotel, but org B's asset
    expect(await pgConstraint(() => db.insert(hotelDocument).values({ documentId: assetB!.id, organizationId: a.organization.id, hotelId: a.hotelRow.id, docType: 'LICENSE', title: 't' }))).toBe('hotel_document_asset_fk')
    // organization B + B's asset + A's hotel: caught by the hotel FK
    expect(await pgConstraint(() => db.insert(hotelDocument).values({ documentId: assetB!.id, organizationId: b.organization.id, hotelId: a.hotelRow.id, docType: 'LICENSE', title: 't' }))).toBe('hotel_document_hotel_fk')
    expect(await db.select().from(hotelDocument)).toEqual([])
  })

  it('rejects a hotel_document without an asset (23503) and a second hotel_document for one asset (23505, primary key)', async () => {
    const { organization, hotelRow, scope } = await setup()
    expect(await pgCode(() => db.insert(hotelDocument).values({ documentId: crypto.randomUUID(), organizationId: organization.id, hotelId: hotelRow.id, docType: 'LICENSE', title: 't' }))).toBe('23503')
    const { asset } = await makeHotelDocument(db, scope)
    expect(await pgCode(() => db.insert(hotelDocument).values({ documentId: asset.id, organizationId: organization.id, hotelId: hotelRow.id, docType: 'OTHER', title: 'again' }))).toBe('23505')
  })

  it('a hotel with documents cannot be deleted, nor an asset still referenced (NO ACTION)', async () => {
    const { hotelRow, scope } = await setup()
    const { asset } = await makeHotelDocument(db, scope)
    const client = getTestClient()
    expect(await pgCode(async () => client`DELETE FROM hotel WHERE id = ${hotelRow.id}`)).toBe('23503')
    expect(await pgCode(async () => client`DELETE FROM document_asset WHERE id = ${asset.id}`)).toBe('23503')
  })
})

describe('organization delete cascades (tenant-root teardown)', () => {
  it('removes only that organization\'s assets and hotel documents', async () => {
    const a = await setup()
    const b = await setup()
    const docA = await makeHotelDocument(db, a.scope)
    const docB = await makeHotelDocument(db, b.scope)

    await platformRepos(db).organizations.deleteCascade(a.organization.id)

    expect(await db.select().from(hotelDocument).where(eq(hotelDocument.documentId, docA.document.documentId))).toEqual([])
    expect(await db.select().from(documentAsset).where(eq(documentAsset.id, docA.asset.id))).toEqual([])
    expect(await db.select().from(hotelDocument).where(eq(hotelDocument.documentId, docB.document.documentId))).toHaveLength(1)
    expect(await db.select().from(documentAsset).where(eq(documentAsset.id, docB.asset.id))).toHaveLength(1)
  })
})

describe('catalog: tables, constraints and indexes', () => {
  it('has exactly the designed constraints with the designed delete actions', async () => {
    const client = getTestClient()
    const rows = await client<Array<{ table: string, name: string, type: string, def: string }>>`
      SELECT t.relname AS "table", c.conname AS name, c.contype AS type, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname IN ('document_asset', 'hotel_document') ORDER BY t.relname, c.conname`
    const byName = Object.fromEntries(rows.map(r => [r.name, r]))
    expect(Object.keys(byName).sort()).toEqual([
      'document_asset_mime_check', 'document_asset_org_id_unique', 'document_asset_organization_id_organization_id_fk', 'document_asset_pkey',
      'document_asset_size_check', 'document_asset_storage_key_unique',
      'hotel_document_asset_fk', 'hotel_document_document_id_pk', 'hotel_document_hotel_fk', 'hotel_document_organization_id_organization_id_fk', 'hotel_document_type_check',
    ])
    expect(byName.document_asset_org_id_unique!.def).toBe('UNIQUE (organization_id, id)')
    expect(byName.document_asset_storage_key_unique!.def).toBe('UNIQUE (storage_key)')
    expect(byName.document_asset_organization_id_organization_id_fk!.def).toBe('FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE CASCADE')
    expect(byName.hotel_document_organization_id_organization_id_fk!.def).toBe('FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE CASCADE')
    expect(byName.hotel_document_asset_fk!.def).toBe('FOREIGN KEY (organization_id, document_id) REFERENCES document_asset(organization_id, id)')
    expect(byName.hotel_document_hotel_fk!.def).toBe('FOREIGN KEY (organization_id, hotel_id) REFERENCES hotel(organization_id, id)')
    expect(byName.hotel_document_document_id_pk!.def).toBe('PRIMARY KEY (document_id)')
  })

  it('has the designed non-key indexes on hotel_document', async () => {
    const client = getTestClient()
    const rows = await client<Array<{ name: string, columns: string[] }>>`
      SELECT i.relname AS name, array_agg(a.attname ORDER BY k.ord) AS columns
      FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
      JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE t.relname = 'hotel_document' AND NOT ix.indisprimary GROUP BY i.relname ORDER BY i.relname`
    expect(rows).toEqual([
      { name: 'hotel_document_asset_idx', columns: ['organization_id', 'document_id'] },
      { name: 'hotel_document_hotel_idx', columns: ['organization_id', 'hotel_id'] },
    ])
  })

  it('applies the column defaults (id, created_at) and leaves archived_at/uploaded_by null', async () => {
    const { scope } = await setup()
    const { asset } = await makeHotelDocument(db, scope)
    expect(asset.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(asset.createdAt).toBeInstanceOf(Date)
    expect(asset.archivedAt).toBeNull()
    expect(asset.uploadedBy).toBeNull()
  })
})

describe('FK index coverage (global "every FK column set gets an index" rule)', () => {
  it('every foreign-key column set on document_asset and hotel_document has a covering index', async () => {
    const client = getTestClient()
    const tables = ['document_asset', 'hotel_document']

    const fkRows = await client<Array<{ tableName: string, constraintName: string, columns: string[] }>>`
      SELECT tbl.relname AS "tableName", con.conname AS "constraintName",
             array_agg(att.attname ORDER BY arr.ord) AS columns
      FROM pg_constraint con
      JOIN pg_class tbl ON tbl.oid = con.conrelid
      JOIN unnest(con.conkey) WITH ORDINALITY AS arr(attnum, ord) ON true
      JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = arr.attnum
      WHERE con.contype = 'f' AND tbl.relname = ANY(${tables})
      GROUP BY tbl.relname, con.conname
    `
    expect(fkRows.map(r => r.constraintName).sort()).toEqual(['document_asset_organization_id_organization_id_fk', 'hotel_document_asset_fk', 'hotel_document_hotel_fk', 'hotel_document_organization_id_organization_id_fk'])

    const indexRows = await client<Array<{ tableName: string, indexName: string, columns: string[] }>>`
      SELECT t.relname AS "tableName", i.relname AS "indexName",
             array_agg(a.attname ORDER BY k.ord) AS columns
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE t.relname = ANY(${tables}) AND ix.indpred IS NULL
      GROUP BY t.relname, i.relname, ix.indkey
    `

    const uncovered = fkRows.filter((fk) => {
      const fkSet = new Set(fk.columns)
      return !indexRows.some((idx) => {
        if (idx.tableName !== fk.tableName || idx.columns.length < fkSet.size) return false
        const leading = new Set(idx.columns.slice(0, fkSet.size))
        return leading.size === fkSet.size && [...fkSet].every(c => leading.has(c))
      })
    })
    expect(uncovered).toEqual([])
  })
})
