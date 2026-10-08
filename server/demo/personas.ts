/**
 * Demo personas (Task 20). PURE DATA: no database or repository imports. The single definition of the
 * demo credentials: `DEMO_ADMIN_EMAIL` and `DEMO_PASSWORD` are read from here by the seed, the demo
 * sign-in endpoint and the tests. The demo password is public by design (it is documented in the README
 * and only ever served by the runtime-gated sign-in endpoint); no hash lives here.
 */

export const DEMO_ADMIN_EMAIL = 'admin@demo.alsafahotels.test'
export const DEMO_PASSWORD = 'DemoPassword123!'

export const DEMO_EMAIL_DOMAIN = 'demo.alsafahotels.test'

export interface DemoPersona {
  key: string
  email: string
  fullName: string
  /** A key of ROLE_DEFINITIONS (shared/constants/roles.ts). */
  roleKey: string
  /** `'all'` = the user holds `all_hotels`; otherwise an explicit list of hotel codes (user_hotel_access rows). */
  hotelCodes: 'all' | readonly string[]
  /** Presentation only (D13): whether Phase 1 has screens for this persona. Never disables an account or alters RBAC. */
  phase1Available: boolean
}

const email = (key: string) => `${key}@${DEMO_EMAIL_DOMAIN}`

export const DEMO_PERSONAS: readonly DemoPersona[] = [
  { key: 'admin', email: DEMO_ADMIN_EMAIL, fullName: 'Faisal Al-Otaibi', roleKey: 'SUPER_ADMIN', hotelCodes: 'all', phase1Available: true },
  { key: 'manager.grand', email: email('manager.grand'), fullName: 'Nora Al-Qahtani', roleKey: 'HOTEL_MANAGER', hotelCodes: ['MKK-GRAND'], phase1Available: true },
  { key: 'manager.madinah', email: email('manager.madinah'), fullName: 'Omar Siddiqui', roleKey: 'HOTEL_MANAGER', hotelCodes: ['MED-CENT', 'MED-QUBA'], phase1Available: true },
  { key: 'reservations', email: email('reservations'), fullName: 'Aisha Rahman', roleKey: 'RESERVATION_MANAGER', hotelCodes: ['MKK-GRAND', 'MKK-AJYAD', 'MKK-AZIZ'], phase1Available: true },
  { key: 'accountant', email: email('accountant'), fullName: 'Khalid Al-Harbi', roleKey: 'ACCOUNTANT', hotelCodes: 'all', phase1Available: false },
  { key: 'hr', email: email('hr'), fullName: 'Maryam Yusuf', roleKey: 'HR_MANAGER', hotelCodes: ['MKK-GRAND', 'MKK-AJYAD', 'MED-CENT'], phase1Available: false },
  { key: 'reception.grand', email: email('reception.grand'), fullName: 'Ahmed Hassan', roleKey: 'RECEPTION', hotelCodes: ['MKK-GRAND'], phase1Available: true },
  { key: 'reception.ajyad', email: email('reception.ajyad'), fullName: 'Imran Chowdhury', roleKey: 'RECEPTION', hotelCodes: ['MKK-AJYAD'], phase1Available: true },
  { key: 'management', email: email('management'), fullName: 'Sarah Al-Mutairi', roleKey: 'READ_ONLY_MANAGEMENT', hotelCodes: 'all', phase1Available: true },
]
