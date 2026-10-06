import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { DEMO_NAMESPACE, demoIds, deterministicId, keyName, uuidV5 } from '../../../db/seed/demo/ids'
import { mulberry32, seedFromString, shuffled, streamFor } from '../../../db/seed/demo/random'
import { buildDemoPlan, versionsCoverEveryNight } from '../../../db/seed/demo/inventory'
import { DEMO_HOTELS, DEMO_ROOM_TYPES, DEMO_SHOWCASE_ROOM, ROOM_TYPE_CODES } from '../../../server/demo/catalog'
import { DEMO_ADMIN_EMAIL, DEMO_PASSWORD, DEMO_PERSONAS } from '../../../server/demo/personas'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'

describe('uuidV5', () => {
  it('matches the RFC 4122 / Python reference vector (DNS namespace, "www.example.com")', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
  })
  it('is a valid version-5 uuid', () => {
    expect(deterministicId('room', 'MKK-GRAND', '401')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('deterministicId', () => {
  it('is stable across calls and distinct across keys', () => {
    expect(deterministicId('hotel', 'MKK-GRAND')).toBe(deterministicId('hotel', 'MKK-GRAND'))
    expect(deterministicId('hotel', 'MKK-GRAND')).not.toBe(deterministicId('hotel', 'MKK-AJYAD'))
    expect(deterministicId('room', 'A', '401')).not.toBe(deterministicId('room', 'B', '401'))
  })
  it('does not confuse part boundaries, whatever characters the parts contain', () => {
    expect(deterministicId('a', 'bc')).not.toBe(deterministicId('ab', 'c'))
    expect(deterministicId('x', 'a|b', 'c')).not.toBe(deterministicId('x', 'a', 'b|c'))
    expect(deterministicId('x', 'a', '')).not.toBe(deterministicId('x', '', 'a'))
    expect(deterministicId('x', '1:a')).not.toBe(deterministicId('x', '1', 'a'))
    expect(keyName('x', ['a|b', 'c'])).not.toBe(keyName('x', ['a', 'b|c']))
  })
  it('the namespace is the fixed documented uuid', () => {
    expect(DEMO_NAMESPACE).toBe('5b1c2f0e-8f0a-4c67-9d6a-3e1f4a7c9b21')
  })
  it('pins known ids so an accidental change of the id scheme (which would invalidate every demo session) is caught', () => {
    expect(demoIds.organization('demo')).toBe('a7351f9a-9328-5fec-9086-ff25b0fc1b91')
    expect(demoIds.user('admin')).toBe('5e512b6c-5798-5001-841c-d470048b108e')
    expect(demoIds.room('MKK-GRAND', '401')).toBe('1abd6ccb-df22-5d8b-a0a1-0c0d1e104091')
    expect(demoIds.hotel('MKK-AJYAD')).toBe('3b088bc0-5529-5272-9918-10a982cd35d4')
  })
})

describe('mulberry32', () => {
  it('produces the same sequence for the same seed and a different one for another seed', () => {
    const a = mulberry32(42); const b = mulberry32(42); const c = mulberry32(43)
    const sa = [a(), a(), a(), a()]
    expect(sa).toEqual([b(), b(), b(), b()])
    expect(sa).not.toEqual([c(), c(), c(), c()])
  })
  it('stays within [0, 1)', () => {
    const r = mulberry32(seedFromString('MKK-GRAND'))
    for (let i = 0; i < 10_000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
  it('pins the first value for seed 42 so an accidental algorithm change is caught', () => {
    expect(mulberry32(42)()).toBeCloseTo(0.6011037519201636, 12)
  })
  it('streams are independent per purpose and reproducible', () => {
    expect(streamFor('MKK-GRAND', 'blocks')()).toBe(streamFor('MKK-GRAND', 'blocks')())
    expect(streamFor('MKK-GRAND', 'blocks')()).not.toBe(streamFor('MKK-GRAND', 'renovations')())
  })
})

describe('shuffled', () => {
  it('is deterministic, a permutation, and does not mutate its input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const one = shuffled(input, mulberry32(7)); const two = shuffled(input, mulberry32(7))
    expect(one).toEqual(two)
    expect([...one].sort((x, y) => x - y)).toEqual(input)
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

describe('demo catalogue arithmetic', () => {
  const beds = new Map(DEMO_ROOM_TYPES.map(t => [t.code, t.beds]))
  it('has exactly 5 hotels, 360 rooms and 4 organization-level room types 3/4/5/6', () => {
    expect(DEMO_HOTELS).toHaveLength(5)
    expect(DEMO_HOTELS.reduce((n, h) => n + h.rooms, 0)).toBe(360)
    expect(DEMO_ROOM_TYPES.map(t => [t.code, t.beds])).toEqual([['TRIPLE', 3], ['QUAD', 4], ['QUINT', 5], ['SIX_BED', 6]])
    expect(DEMO_HOTELS.filter(h => h.city === 'Makkah')).toHaveLength(3)
    expect(DEMO_HOTELS.filter(h => h.city === 'Madinah')).toHaveLength(2)
  })
  it.each(DEMO_HOTELS.map(h => [h.code, h] as const))('%s: distribution sums to rooms, rooms = floors x 10, capacity = sum of beds', (_code, h) => {
    expect(ROOM_TYPE_CODES.reduce((n, c) => n + h.distribution[c], 0)).toBe(h.rooms)
    expect(h.floors * h.roomsPerFloor).toBe(h.rooms)
    expect(ROOM_TYPE_CODES.reduce((n, c) => n + h.distribution[c] * beds.get(c)!, 0)).toBe(h.initialCapacity)
  })
  it('tabulated per-hotel capacities and the organization reference 1578 / 360', () => {
    expect(DEMO_HOTELS.map(h => [h.code, h.rooms, h.initialCapacity])).toEqual([['MKK-GRAND', 100, 460], ['MKK-AJYAD', 80, 310], ['MKK-AZIZ', 60, 300], ['MED-CENT', 70, 296], ['MED-QUBA', 50, 212]])
    expect(DEMO_HOTELS.reduce((n, h) => n + h.initialCapacity, 0)).toBe(1578)
    expect(310 / 80).toBe(3.875)
  })
})

describe('demo personas data', () => {
  it('has the nine personas with real roles, the admin login and one shared password constant', () => {
    expect(DEMO_PERSONAS.map(p => p.key)).toEqual(['admin', 'manager.grand', 'manager.madinah', 'reservations', 'accountant', 'hr', 'reception.grand', 'reception.ajyad', 'management'])
    for (const p of DEMO_PERSONAS) expect(ROLE_DEFINITIONS[p.roleKey]).toBeDefined()
    expect(DEMO_PERSONAS[0]!.email).toBe(DEMO_ADMIN_EMAIL)
    expect(DEMO_ADMIN_EMAIL).toBe('admin@demo.alsafahotels.test')
    expect(new Set(DEMO_PERSONAS.map(p => p.email)).size).toBe(9)
    expect(DEMO_PERSONAS.filter(p => !p.phase1Available).map(p => p.key)).toEqual(['accountant', 'hr'])
    expect(DEMO_PASSWORD.length).toBeGreaterThanOrEqual(12)
  })
  it('only names hotels that exist in the catalogue', () => {
    const codes = new Set(DEMO_HOTELS.map(h => h.code))
    for (const p of DEMO_PERSONAS) if (p.hotelCodes !== 'all') for (const c of p.hotelCodes) expect(codes.has(c)).toBe(true)
  })
})

describe('buildDemoPlan (the pure generator)', () => {
  const plan = buildDemoPlan('2026-09-01')

  it('is deterministic: the same anchor gives a structurally identical plan', () => {
    expect(JSON.stringify(buildDemoPlan('2026-09-01'))).toBe(JSON.stringify(plan))
  })

  it('a different anchor changes the anchor-relative rows (blocks) but not the fixed-calendar rows', () => {
    const other = buildDemoPlan('2026-11-15')
    expect(JSON.stringify(other.hotels.map(h => h.blocks))).not.toBe(JSON.stringify(plan.hotels.map(h => h.blocks)))
    expect(JSON.stringify(other.hotels.map(h => [h.versions, h.periods, h.overrides]))).toBe(JSON.stringify(plan.hotels.map(h => [h.versions, h.periods, h.overrides])))
  })

  it('rejects an invalid anchor date', () => {
    expect(() => buildDemoPlan('2026-02-30')).toThrow()
  })

  it('every id is unique within its kind and is a UUID v5', () => {
    const all = [
      ...plan.roomTypes.map(r => r.id),
      ...plan.hotels.flatMap(h => [h.hotel.id, ...h.floors.map(f => f.id), ...h.rooms.map(r => r.row.id), ...h.versions.map(v => v.id), ...h.periods.map(p => p.id), ...h.overrides.map(o => o.id), ...h.blocks.map(b => b.row.id)]),
    ]
    expect(new Set(all).size).toBe(all.length)
    for (const id of all) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('room numbers are <level><nn>, unique per hotel, ten per floor, with the showcase room a Quad on level 4', () => {
    for (const h of plan.hotels) {
      expect(new Set(h.rooms.map(r => r.roomNumber)).size).toBe(h.spec.rooms)
      for (const f of h.floors) expect(h.rooms.filter(r => r.level === f.level)).toHaveLength(10)
      for (const r of h.rooms) expect(r.roomNumber).toMatch(new RegExp(`^${r.level}\\d{2}$`))
      for (const code of ROOM_TYPE_CODES) expect(h.rooms.filter(r => r.typeCode === code)).toHaveLength(h.spec.distribution[code])
    }
    const grand = plan.hotels.find(h => h.spec.code === DEMO_SHOWCASE_ROOM.hotelCode)!
    const r401 = grand.rooms.find(r => r.roomNumber === '401')!
    expect(r401.level).toBe(4)
    expect(r401.typeCode).toBe('QUAD')
    expect(r401.versions).toHaveLength(1)
  })

  it('no override exists for a room that is not in inventory for the whole period (the Task 15 coverage rule)', () => {
    for (const h of plan.hotels) {
      const roomById = new Map(h.rooms.map(r => [r.row.id, r]))
      for (const o of h.overrides) {
        const nights = { from: o.validFrom, to: o.validTo }
        expect(versionsCoverEveryNight(roomById.get(o.roomId)!.versions, nights)).toBe(true)
        const period = h.periods.find(p => p.id === o.periodId)!
        expect([o.validFrom, o.validTo]).toEqual([period.startDate, period.endDate])
      }
    }
  })
})

describe('demo generation source rules (static fitness)', () => {
  const root = join(import.meta.dirname, '../../..')
  const files = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []))
  const demoFiles = [...files('db/seed/demo'), ...files('server/demo')]

  it('finds the demo source files', () => {
    expect(demoFiles.length).toBeGreaterThanOrEqual(6)
  })

  it('uses no Math.random, Date.now, randomUUID or new Date(<string>) in demo generation (comments ignored)', () => {
    const offences: string[] = []
    for (const file of demoFiles) {
      const sf = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node) => {
        const at = () => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
          const text = `${node.expression.text}.${node.name.text}`
          if (text === 'Math.random' || text === 'Date.now' || text === 'Date.parse') offences.push(`${at()} ${text}`)
        }
        if (ts.isIdentifier(node) && node.text === 'randomUUID') offences.push(`${at()} randomUUID`)
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
          const arg = node.arguments?.[0]
          if (!arg || ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg)) offences.push(`${at()} new Date(${arg ? '<string>' : ''})`)
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
    expect(offences).toEqual([])
  })

  it('server/demo is pure data: no database, repository, seed or password-hashing imports', () => {
    for (const file of files('server/demo')) {
      const source = readFileSync(join(root, file), 'utf8')
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]!)
      for (const s of specifiers) expect(s, `${file} imports ${s}`).not.toMatch(/db\/|repositories|drizzle|password|seed|node:crypto|argon/)
    }
  })

  it('db/seed/** never imports db/schema or drizzle-orm (it writes through repositories)', () => {
    for (const file of files('db/seed')) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source, file).not.toMatch(/from\s+'[^']*(?:db\/schema|\/schema)(?:\/[^']*)?'/)
      expect(source, file).not.toMatch(/from\s+'drizzle-orm/)
    }
  })
})
