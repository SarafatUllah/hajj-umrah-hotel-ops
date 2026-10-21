// Booking-module repositories, hotel-scoped (organization_id AND hotel_id). Every *Repository exported here
// must have a case for each of its methods in tests/integration/security/repositoryRegistry.ts.
export * from './bookingInventoryRepository'
export * from './hotelRuleRepository'
export * from './bookingSettingRepository'
export * from './priceQuoteRepository'
export * from './documentSequenceRepository'
export * from './bookingRepository'
export * from './guestRepository'
export * from './passportScanRepository'
