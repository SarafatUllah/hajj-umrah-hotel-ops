import { describe, expect, it } from 'vitest'
import { HOTEL_SETTINGS, resolveSettings, updateSettingsSchema } from '../../../shared/business-rules/hotelSettings'

describe('resolveSettings', () => {
  it('fills in every registry default when nothing is stored', () => {
    expect(resolveSettings({})).toEqual({
      'inventory.maintenanceBlocksSales': true,
      'calendar.defaultRangeDays': 31,
    })
  })

  it('uses a stored value over the default when present', () => {
    expect(resolveSettings({ 'inventory.maintenanceBlocksSales': false })).toEqual({
      'inventory.maintenanceBlocksSales': false,
      'calendar.defaultRangeDays': 31,
    })
  })

  it('ignores a stored key that is not in the registry (a retired setting)', () => {
    const result = resolveSettings({ 'some.retired.setting': 'anything' })
    expect(result).toEqual({
      'inventory.maintenanceBlocksSales': true,
      'calendar.defaultRangeDays': 31,
    })
    expect(Object.keys(result)).not.toContain('some.retired.setting')
  })

  it('every registry key has both a schema and a default', () => {
    for (const key of Object.keys(HOTEL_SETTINGS) as Array<keyof typeof HOTEL_SETTINGS>) {
      const definition = HOTEL_SETTINGS[key]
      expect(definition.schema.safeParse(definition.default).success).toBe(true)
    }
  })
})

describe('updateSettingsSchema', () => {
  it('accepts a partial update of one known key', () => {
    expect(updateSettingsSchema.safeParse({ 'inventory.maintenanceBlocksSales': false }).success).toBe(true)
  })

  it('accepts an empty object', () => {
    expect(updateSettingsSchema.safeParse({}).success).toBe(true)
  })

  it('rejects an unknown key (.strict())', () => {
    expect(updateSettingsSchema.safeParse({ 'not.a.real.setting': true }).success).toBe(false)
  })

  it('rejects the wrong type for a known key', () => {
    expect(updateSettingsSchema.safeParse({ 'inventory.maintenanceBlocksSales': 'yes' }).success).toBe(false)
  })

  it('rejects calendar.defaultRangeDays below the registry minimum (7)', () => {
    expect(updateSettingsSchema.safeParse({ 'calendar.defaultRangeDays': 6 }).success).toBe(false)
  })

  it('accepts calendar.defaultRangeDays at the registry minimum (7)', () => {
    expect(updateSettingsSchema.safeParse({ 'calendar.defaultRangeDays': 7 }).success).toBe(true)
  })

  it('rejects a non-integer calendar.defaultRangeDays', () => {
    expect(updateSettingsSchema.safeParse({ 'calendar.defaultRangeDays': 10.5 }).success).toBe(false)
  })
})
