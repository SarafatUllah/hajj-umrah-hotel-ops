/** The staff session's response shapes (`GET /api/auth/me`, S1 of UI-UX-MASTER-DIRECTION §42). */
import type { Permission } from '../constants/permissions'
import type { IsoDate } from '../utils/dates'

export interface SessionOrganization {
  id: string
  name: string
  slug: string
  isDemo: boolean
}

export interface SessionRole {
  key: string
  name: string
}

export interface StaffIdentity {
  userId: string
  organizationId: string
  email: string
  fullName: string
}

/** Who is signed in, resolved fresh on every call: what they may do, and in which hotels. */
export interface StaffMe {
  user: StaffIdentity
  organization: SessionOrganization
  roles: SessionRole[]
  permissions: Permission[]
  allHotels: boolean
  hotelIds: string[]
  /** Two-factor setup is required before anything else (`/settings/two-factor`). */
  twoFactorEnrollmentRequired: boolean
}

/** `POST /api/auth/login`: who signed in (the session cookie is set; `me` then says what they may do). */
export interface StaffSignIn {
  user: { id: string, organizationId: string, email: string, fullName: string }
}

export interface TwoFactorStatus {
  enabled: boolean
  /** A setup was started and not confirmed yet. */
  setupPending: boolean
  /** One of the user's roles requires two-factor authentication. */
  requiredByRole: boolean
}

export interface TwoFactorSetup {
  /** Base32 secret, shown once for manual entry. */
  secret: string
  /** `otpauth://` URI, rendered as a QR code by the client. */
  otpauthUri: string
}

export interface DemoSignInPersona {
  email: string
  fullName: string
  roleName: string
  hotels: Array<{ code: string, name: string }>
  phase1Available: boolean
}

/** The demo sign-in data (D9): only where the demo is enabled — elsewhere the endpoint is an unknown route. */
export interface DemoSignInPayload {
  organizationSlug: string
  password: string
  personas: DemoSignInPersona[]
}

export interface DemoResetResult {
  organizationId: string
  anchorDate: IsoDate
}
