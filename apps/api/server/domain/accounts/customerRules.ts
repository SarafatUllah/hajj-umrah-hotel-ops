/**
 * The e-mail address a customer signs in with (D-P2-68): theirs only once proven by a code — an unproven address on
 * the row is contact data, never an identity.
 */
export function verifiedEmailOf(customer: { email: string | null, emailVerifiedAt: Date | null }): string | null {
  return customer.emailVerifiedAt ? customer.email : null
}
