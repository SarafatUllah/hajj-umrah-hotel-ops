/**
 * The booking module's PUBLIC service API (ticket 5): other modules — the Phase 1 inventory services, later
 * transport — import only from here, never from the module's internal files (enforced by
 * tests/unit/architecture/layering.test.ts).
 */
export { assertBookingsStillFit, type InventoryChange } from './inventoryGuard'
export { createBookingRule, deleteBookingRule, listBookingRules, updateBookingRule, type BookingRuleDto } from './bookingRulesService'
export { getBookingSettings, updateBookingSettings, type BookingSettingsDto } from './bookingSettingsService'
