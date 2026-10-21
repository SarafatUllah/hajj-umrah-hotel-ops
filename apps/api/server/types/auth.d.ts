declare module '#auth-utils' {
  interface User {
    id: string
    organizationId: string
    email: string
    fullName: string
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
