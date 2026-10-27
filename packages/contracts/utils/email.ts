/**
 * Canonical form of an e-mail address: `app_user.email`, an agency user's, and a customer's sign-in address
 * (`customer.email`, D-P2-68). Applied before every lookup and every insert so "Admin@Example.com" and
 * "admin@example.com" resolve to the same account. The (organization_id, email) unique indexes are plain
 * case-sensitive indexes, so every code path that reads or writes these columns must go through this function
 * (the customer table also checks the stored form).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
