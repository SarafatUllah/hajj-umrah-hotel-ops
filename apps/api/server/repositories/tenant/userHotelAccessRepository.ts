import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { userHotelAccess } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type UserHotelAccessRow = typeof userHotelAccess.$inferSelect

export class UserHotelAccessRepository {
  private readonly q: OrgQuery

  constructor(db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async hotelIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.q.select(userHotelAccess, eq(userHotelAccess.userId, userId))
    return rows.map(r => r.hotelId)
  }

  /**
   * Replaces the full set of hotel grants for a user in one delete + one (multi-row) insert. A
   * hotelId that does not belong to this organization is rejected by the composite foreign key
   * (user_hotel_access_hotel_fk), never silently dropped.
   */
  async replaceForUser(userId: string, hotelIds: readonly string[], grantedBy: string | null): Promise<void> {
    await this.q.delete(userHotelAccess, eq(userHotelAccess.userId, userId))
    if (hotelIds.length === 0) return
    await this.q.insertMany(userHotelAccess, hotelIds.map(hotelId => ({ userId, hotelId, grantedBy })))
  }

  async userIdsForHotel(hotelId: string): Promise<string[]> {
    const rows = await this.q.select(userHotelAccess, eq(userHotelAccess.hotelId, hotelId))
    return rows.map(r => r.userId)
  }
}
