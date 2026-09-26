import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { permission } from '../../../db/schema'

export type PermissionRow = typeof permission.$inferSelect

/** Platform family (unscoped by design): the permission catalog is global, shared by every organization. */
export class PlatformPermissionCatalogRepository {
  constructor(private readonly db: DbOrTx) {}

  /** Inserts missing keys and refreshes the description of existing ones. */
  async upsertAll(entries: readonly PermissionRow[]): Promise<void> {
    if (entries.length === 0) return
    await this.db
      .insert(permission)
      .values([...entries])
      .onConflictDoUpdate({ target: permission.key, set: { description: sql`excluded.description` } })
  }

  async listKeys(): Promise<string[]> {
    const rows = await this.db.select({ key: permission.key }).from(permission)
    return rows.map(r => r.key)
  }
}
