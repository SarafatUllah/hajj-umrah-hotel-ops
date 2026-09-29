import { z } from 'zod'
import { MAX_CALENDAR_DAYS } from '../constants/inventory'

/**
 * The hotel-settings registry: the single place a new per-hotel setting is added. A new setting
 * needs exactly one line here — never a migration (`hotel_setting` stores `key`/`value` as jsonb) and
 * never a hardcoded branch in `resolveSettings`/`updateSettingsSchema` below, both of which are built
 * generically off this object's keys.
 */
export const HOTEL_SETTINGS = {
  'inventory.maintenanceBlocksSales': { schema: z.boolean(), default: true },
  'calendar.defaultRangeDays': { schema: z.number().int().min(7).max(MAX_CALENDAR_DAYS), default: 31 },
} as const

export type HotelSettingKey = keyof typeof HOTEL_SETTINGS

export type ResolvedSettings = { [K in HotelSettingKey]: z.infer<typeof HOTEL_SETTINGS[K]['schema']> }

/**
 * Fills in the registry's defaults for any key missing from `stored`; a key present in `stored` that
 * is not in the registry (a setting retired from a later registry edit) is silently ignored, since
 * only registry keys are ever read out.
 */
export function resolveSettings(stored: Record<string, unknown>): ResolvedSettings {
  const result = {} as ResolvedSettings
  for (const key of Object.keys(HOTEL_SETTINGS) as HotelSettingKey[]) {
    const definition = HOTEL_SETTINGS[key]
    const value = Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : definition.default
    result[key] = value as never
  }
  return result
}

const updateSettingsShape = Object.fromEntries(
  (Object.keys(HOTEL_SETTINGS) as HotelSettingKey[]).map(key => [key, HOTEL_SETTINGS[key].schema.optional()]),
) as { [K in HotelSettingKey]: z.ZodOptional<typeof HOTEL_SETTINGS[K]['schema']> }

/** Every known key is optional; `.strict()` so an unrecognized key (a typo, or a retired setting) is a 422. */
export const updateSettingsSchema = z.object(updateSettingsShape).strict()

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>
