/**
 * The booking module's PUBLIC service API (ticket 5): other modules — the Phase 1 inventory services, later
 * transport — import only from here, never from the module's internal files (enforced by
 * tests/unit/architecture/layering.test.ts).
 */
export { assertBookingsStillFit, type InventoryChange } from './inventoryGuard'
export { createBookingRule, deleteBookingRule, listBookingRules, updateBookingRule, type BookingRuleDto } from './bookingRulesService'
export { getBookingSettings, updateBookingSettings, type BookingSettingsDto } from './bookingSettingsService'
export { createQuoteForAgency, declineQuote, expireOfferedQuotes, getAgencyQuote, getQuote, listAgencyQuotes, listQuotes, offerQuote, requestQuote, type OfferedQuote, type QuoteDto, type QuotePage, type RequestedQuote } from './quoteService'
export { expireLapsedBookings, placeHold, searchStay, type HeldBooking, type StayOption, type StayOptionRoom, type StaySearchResult } from './holdService'
export type { Booker } from './stayFacts'
export { agencyBookingReceipt, bookingReceipt, confirmAgencyBooking, confirmBooking, getAgencyBooking, getBooking, holdAgencyStay, holdStayForAgency, listAgencyBookings, listBookings, searchAgencyStay, searchStayForAgency, type BookingDetailDto, type BookingDto, type BookingPage, type ReceiptDto } from './bookingService'
