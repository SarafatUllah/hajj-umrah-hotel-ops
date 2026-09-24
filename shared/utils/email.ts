/**
 * Canonical form for app_user.email. Applied before every lookup and every
 * insert so "Admin@Example.com" and "admin@example.com" resolve to the same
 * account. This is application-level normalization only — the
 * (organization_id, email) unique index is still a plain case-sensitive
 * index, so every code path that reads or writes app_user.email must go
 * through this function.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
