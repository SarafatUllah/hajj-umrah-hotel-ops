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
export { listAgencyGuests, listGuests, saveAgencyGuest, saveGuest, type GuestDetailsDto, type GuestSlotDto, type GuestWarning } from './guestService'
export { agencyScanImage, confirmAgencyScan, confirmScan, discardAgencyScan, discardScan, listAgencyScans, listScans, scanImage, setPassportReadQueue, uploadAgencyScan, uploadScan, type PassportScanDto, type ScanUpload } from './passportScanService'
export { purgeExpiredPassportImages } from './passportImages'
export { readPassportScan } from './passportReading'
export { checkInGuest, checkOutGuest, lookupReceipt, markGuestNoShow, type CheckInLookupDto, type GuestMoveDto } from './checkInService'
export { completeHotelTask, listHotelTasks, type HotelTaskDto } from './hotelTaskService'
export { sendDetailsReminders } from './detailsReminder'
export { getOccupancy, getOccupancyDay, type OccupancyDayViewDto, type OccupancyRangeDto } from './occupancyService'
export { notifyBookingConfirmed } from './bookingEvents'
export { readAgencyGuests, readBookingSlots, type AgencyGuestView, type BookingSlotsView } from './publicRead'
export { eraseExpiredGuestData } from './guestRetention'
