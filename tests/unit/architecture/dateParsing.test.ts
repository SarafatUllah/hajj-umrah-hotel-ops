import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { readRepoSources } from '../../support/layering'

/** Directories scanned for ad-hoc date-string parsing; production code only. */
const SCANNED_DIRS = ['server/', 'shared/'] as const
/** The one file allowed to parse date strings with `new Date(string)` — everything else must go through it. */
const EXEMPT_FILE = 'shared/utils/dates.ts'

function scriptKindOf(file: string): ts.ScriptKind {
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * Finds `new Date('…')` / `` new Date(`…`) `` and `Date.parse(…)` call sites — the two ways a date
 * string can be parsed with implicit local-time semantics instead of going through
 * shared/utils/dates.ts. `new Date()` and `new Date(<number>)` are not flagged.
 */
export function findDateParsingViolations(sources: Record<string, string>): string[] {
  const violations: string[] = []
  for (const [file, source] of Object.entries(sources)) {
    if (!SCANNED_DIRS.some(d => file.startsWith(d))) continue
    if (file === EXEMPT_FILE) continue

    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file))
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
        const arg = node.arguments?.[0]
        if (arg && (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg))) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
          violations.push(`${file}:${line}: new Date(<string>) — parse date strings only in shared/utils/dates.ts`)
        }
      }
      else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'parse' && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Date') {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        violations.push(`${file}:${line}: Date.parse(...) — parse date strings only in shared/utils/dates.ts`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return violations
}

describe('date-parsing checker (meta-tests: the checker itself is tested)', () => {
  it('flags new Date with a string literal argument', () => {
    expect(findDateParsingViolations({ 'server/x.ts': 'const d = new Date(\'2027-01-01\')' })).toHaveLength(1)
  })

  it('flags new Date with a template literal argument, with and without substitutions', () => {
    expect(findDateParsingViolations({ 'shared/x.ts': 'const d = new Date(`${y}-01-01`)' })).toHaveLength(1)
    expect(findDateParsingViolations({ 'shared/x.ts': 'const d = new Date(`2027-01-01`)' })).toHaveLength(1)
  })

  it('flags Date.parse regardless of argument shape', () => {
    expect(findDateParsingViolations({ 'server/x.ts': 'Date.parse(\'2027-01-01\')' })).toHaveLength(1)
  })

  it('allows new Date() and new Date(<number>)', () => {
    expect(findDateParsingViolations({ 'server/x.ts': 'const a = new Date(); const b = new Date(1234567890)' })).toEqual([])
  })

  it('is exempt inside shared/utils/dates.ts only', () => {
    expect(findDateParsingViolations({ 'shared/utils/dates.ts': 'new Date(\'2027-01-01\')' })).toEqual([])
    expect(findDateParsingViolations({ 'shared/utils/otherDates.ts': 'new Date(\'2027-01-01\')' })).toHaveLength(1)
  })

  it('does not scan outside server/ and shared/ (tests keep constructing fixture Dates)', () => {
    expect(findDateParsingViolations({ 'tests/unit/shared/dates.test.ts': 'new Date(\'2027-05-01T22:30:00Z\')' })).toEqual([])
    expect(findDateParsingViolations({ 'db/seed/demo/x.ts': 'new Date(\'2027-05-01\')' })).toEqual([])
  })

  it('reports the line of the offending call', () => {
    const [v] = findDateParsingViolations({ 'server/x.ts': 'const a = 1\n\nconst d = new Date(\'2027-01-01\')' })
    expect(v).toMatch(/^server\/x\.ts:3:/)
  })
})

describe('date-parsing fitness check on the real repository', () => {
  const sources = readRepoSources(join(import.meta.dirname, '../../..'))

  it('reads the real source tree', () => {
    expect(Object.keys(sources)).toEqual(expect.arrayContaining(['shared/utils/dates.ts']))
  })

  it('no file under server/ or shared/, outside shared/utils/dates.ts, parses a date string with new Date(...) or Date.parse(...)', () => {
    expect(findDateParsingViolations(sources)).toEqual([])
  })
})
