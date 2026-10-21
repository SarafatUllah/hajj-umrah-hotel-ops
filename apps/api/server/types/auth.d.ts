import type { PrincipalKind } from '@hajj/contracts/constants/principals'

declare module '#auth-utils' {
  interface User {
    id: string
    organizationId: string
    email: string
    fullName: string
    /** Absent on sessions created before Phase 2 — those are staff sessions. */
    kind?: PrincipalKind
    /** The user's `session_version` at sign-in (absent before Phase 2 = 1). */
    sessionVersion?: number
  }

  /**
   * Identity only (Task 7): no permission snapshot, no hotel-access snapshot. Authorization is
   * resolved fresh from the database on every request via resolveAuthContext — never trusted from
   * the session.
   */
  interface UserSession {
    loggedInAt: number
  }
}

export {}
