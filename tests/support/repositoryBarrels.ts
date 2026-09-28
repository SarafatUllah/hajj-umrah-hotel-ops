/**
 * Directories of scoped repositories and their barrels. The isolation-registry coverage test walks
 * every barrel; the layering fitness test rejects any class under server/repositories/ that is not in
 * base/, platform/ (allow-listed) or one of these directories. Adding a barrel is one line
 * (Task 6: `{ dir: 'server/repositories/hotel', load: () => import('../../server/repositories/hotel') },`).
 * Loaders are lazy, so importing this module loads no repository code.
 */
export const REPOSITORY_BARRELS: ReadonlyArray<{ dir: string, load: () => Promise<Record<string, unknown>> }> = [
  { dir: 'server/repositories/tenant', load: () => import('../../server/repositories/tenant') },
  { dir: 'server/repositories/hotel', load: () => import('../../server/repositories/hotel') },
]
