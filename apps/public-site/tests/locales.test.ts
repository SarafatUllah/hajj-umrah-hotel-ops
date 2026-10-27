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

/** Every message key the site's code names (`t('a.b')`, and the keys written out in a `t(cond ? 'a.b' : 'c.d')`). */
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
  for (const file of files) for (const match of readFileSync(file, 'utf8').matchAll(/'((?:site|home|signIn|book|bookings|account|common)\.[a-zA-Z0-9_.]+)'/g)) keys.add(match[1]!)
  return [...keys].sort()
}

describe('the public site\'s locales', () => {
  it('English and Arabic have exactly the same keys', () => {
    expect(keysOf(ar).sort()).toEqual(keysOf(en).sort())
  })

  it('no message holds a bare @ (vue-i18n reads it as a link to another message): an address is written name{\'@\'}example.com', () => {
    for (const tree of [en, ar]) {
      const bare = keysOf(tree).filter(key => String(at(tree, key)).replaceAll('{\'@\'}', '').includes('@'))
      expect(bare).toEqual([])
    }
  })

  it('every key the code uses exists, in the site or the shared layer', () => {
    const used = usedKeys()
    expect(used).toContain('signIn.emailInvalid')
    expect(used.filter(key => typeof at(en, key) !== 'string' && typeof at(layerEn, key) !== 'string')).toEqual([])
  })
})
