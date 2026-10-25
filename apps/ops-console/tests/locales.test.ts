import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type Tree = { [key: string]: string | Tree }
const read = (path: string): Tree => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'))
const en = read('../i18n/locales/en.json')
const ar = read('../i18n/locales/ar.json')
const layerEn = read('../../../packages/ui/i18n/locales/en.json')

const keysOf = (tree: Tree, prefix = ''): string[] => Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [`${prefix}${key}`] : keysOf(value, `${prefix}${key}.`)))
const at = (tree: Tree, path: string): unknown => path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree)

/** Every static message key the console's code asks for (`t('a.b')`). */
function usedKeys(): string[] {
  const root = fileURLToPath(new URL('../app', import.meta.url))
  const files: string[] = []
  const walk = (dir: string) => readdirSync(dir).forEach((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(vue|ts)$/.test(name)) files.push(path)
  })
  walk(root)
  const keys = new Set<string>()
  for (const file of files) for (const match of readFileSync(file, 'utf8').matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) keys.add(match[1]!)
  return [...keys].sort()
}

describe('the console locales (§13)', () => {
  it('English and Arabic have exactly the same keys', () => {
    expect(keysOf(ar).sort()).toEqual(keysOf(en).sort())
  })

  it('every key the code uses exists, in the console or the shared layer', () => {
    const missing = usedKeys().filter(key => typeof at(en, key) !== 'string' && typeof at(layerEn, key) !== 'string')
    expect(missing).toEqual([])
  })

  it('Arabic plural messages give all six forms', () => {
    for (const key of keysOf(en).filter(k => String(at(en, k)).includes(' | '))) expect(String(at(ar, key)).split(' | ')).toHaveLength(6)
  })
})
