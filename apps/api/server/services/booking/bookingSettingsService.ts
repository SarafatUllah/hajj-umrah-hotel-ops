import type { BookingSettingsPatch } from '@hajj/contracts/schemas/bookingRules'
import { ValidationError } from '../../errors/domainError'
import { bookingOrgRepos, tenantRepos } from '../../repositories'
import type { BookingSettingRow } from '../../repositories/booking'
import type { AuthContext } from '../../security/authContext'
import { requireAllHotels, requireOrgPermission } from '../../security/authorize'
import type { OrganizationScope } from '../../security/scope'
import { recordAudit } from '../audit'

export type BookingSettingsDto = Omit<BookingSettingRow, 'organizationId' | 'updatedAt' | 'updatedBy'> & { updatedAt: string }

/** The database handle a repository accepts (a service may not import db/client itself). */
type Db = Parameters<typeof bookingOrgRepos>[0]

const toDto = ({ organizationId: _org, updatedBy: _by, updatedAt, ...rest }: BookingSettingRow): BookingSettingsDto => ({ ...rest, updatedAt: updatedAt.toISOString() })

/** The organization's booking settings, defaults included (the row is created on first use). For booking services. */
export async function loadBookingSettings(db: Db, scope: OrganizationScope): Promise<BookingSettingRow> {
  return bookingOrgRepos(db, scope).settings.ensure()
}

export async function getBookingSettings(ctx: AuthContext): Promise<BookingSettingsDto> {
  requireOrgPermission(ctx, 'booking.view')
  return toDto(await loadBookingSettings(ctx.db, ctx.scope))
}

/**
 * Changes organization-wide booking settings (v7 §15: hold and request lifetimes, quote validity, individual
 * limits, child and infant ages, passport rules, WhatsApp). Organization-wide, so only a caller with access to
 * every hotel may change them (like Phase 1's organization-level writes). The row is locked; the infant age must
 * stay below the child age. Audited with before/after of the changed fields only.
 */
export async function updateBookingSettings(ctx: AuthContext, patch: BookingSettingsPatch): Promise<BookingSettingsDto> {
  requireOrgPermission(ctx, 'booking.settings')
  requireAllHotels(ctx)
  return ctx.db.transaction(async (tx) => {
    const repo = bookingOrgRepos(tx, ctx.scope).settings
    const current = await repo.ensureForUpdate()
    const merged = { ...current, ...patch }
    if (merged.infantAgeLimit > merged.childAgeLimit) throw new ValidationError('INVALID_AGE_LIMITS', 'The infant age limit must not be above the child age limit')

    const changed = Object.keys(patch).filter(key => current[key as keyof BookingSettingRow] !== patch[key as keyof BookingSettingsPatch]) as Array<keyof BookingSettingsPatch>
    if (changed.length === 0) return toDto(current)
    const updated = await repo.update(patch, ctx.identity.userId, ctx.now())
    await recordAudit(tenantRepos(tx, ctx.scope).audit, ctx.identity.userId, {
      entityType: 'booking_setting',
      entityId: ctx.scope.organizationId,
      action: 'BOOKING_SETTINGS_CHANGED',
      before: Object.fromEntries(changed.map(key => [key, current[key]])),
      after: Object.fromEntries(changed.map(key => [key, updated[key]])),
    })
    return toDto(updated)
  })
}
