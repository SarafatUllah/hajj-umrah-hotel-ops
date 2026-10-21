import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENCY_STATUSES } from '@hajj/contracts/constants/accounts'
import { BOOKING_STATUSES, GUEST_STATUSES, HOTEL_TASK_STATUSES } from '@hajj/contracts/constants/booking'
import { HOTEL_STATUSES } from '@hajj/contracts/constants/inventory'
import { PASSPORT_SCAN_STATUSES } from '@hajj/contracts/constants/pilgrimData'
import { QUOTE_STATUSES } from '@hajj/contracts/constants/pricing'
import { STATUS_REGISTRY, type StatusDomain } from '../app/utils/statusRegistry'

type Tree = { [key: string]: string | Tree }
const load = (lang: string): Tree => JSON.parse(readFileSync(fileURLToPath(new URL(`../i18n/locales/${lang}.json`, import.meta.url)), 'utf8'))
const en = load('en')
const ar = load('ar')

/** Every leaf key as `a.b.c`. */
function keysOf(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => typeof value === 'string' ? [`${prefix}${key}`] : keysOf(value, `${prefix}${key}.`))
}
const at = (tree: Tree, path: string): unknown => path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree)

/** The error codes the API can answer with: the first argument of every DomainError it constructs, plus the mapped ones. */
function serverErrorCodes(): string[] {
  const root = fileURLToPath(new URL('../../../apps/api/server', import.meta.url))
  const files: string[] = []
  const walk = (dir: string) => readdirSync(dir).forEach((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (name.endsWith('.ts')) files.push(path)
  })
  walk(root)
  const codes = new Set<string>()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:ValidationError|ConflictError|NotFoundError|ForbiddenError|UnauthenticatedError|TooManyRequestsError|ServiceUnavailableError|PayloadTooLargeError)\(\s*'([A-Z0-9_]+)'/g)) codes.add(match[1]!)
    // The database-error map (`dbErrors.ts`) and the hand-built error bodies (`data: { code: … }`).
    const mapped = file.endsWith('dbErrors.ts') ? /code: '([A-Z0-9_]+)'/g : /data: \{ code: '([A-Z0-9_]+)'/g
    for (const match of source.matchAll(mapped)) codes.add(match[1]!)
  }
  return [...codes].sort()
}

describe('locales (§13, acceptance 11)', () => {
  it('English and Arabic have exactly the same keys', () => {
    expect(keysOf(ar).sort()).toEqual(keysOf(en).sort())
  })

  it('every error code the API can send has an English and an Arabic message', () => {
    const codes = serverErrorCodes()
    expect(codes.length).toBeGreaterThan(100)
    const missing = codes.filter(code => typeof at(en, `errors.codes.${code}`) !== 'string' || typeof at(ar, `errors.codes.${code}`) !== 'string')
    expect(missing).toEqual([])
  })

  it('every status value has a look in the registry and a label in both languages', () => {
    const statuses: Record<StatusDomain, readonly string[]> = {
      booking: BOOKING_STATUSES, guest: GUEST_STATUSES, quote: QUOTE_STATUSES, hotel: HOTEL_STATUSES,
      agency: AGENCY_STATUSES, scan: PASSPORT_SCAN_STATUSES, task: HOTEL_TASK_STATUSES,
    }
    for (const [domain, values] of Object.entries(statuses) as Array<[StatusDomain, readonly string[]]>) {
      expect(Object.keys(STATUS_REGISTRY[domain]).sort()).toEqual([...values].sort())
      for (const value of values) {
        expect(typeof at(en, `status.${domain}.${value}`)).toBe('string')
        expect(typeof at(ar, `status.${domain}.${value}`)).toBe('string')
      }
    }
  })

  it('Arabic plural messages give all six forms', () => {
    const plurals = keysOf(ar).filter(key => String(at(en, key)).includes(' | '))
    expect(plurals.length).toBeGreaterThan(0)
    for (const key of plurals) expect(String(at(ar, key)).split(' | ')).toHaveLength(6)
  })
})
