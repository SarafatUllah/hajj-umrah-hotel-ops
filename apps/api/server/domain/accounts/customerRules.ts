/**
 * The e-mail address a customer signs in with (D-P2-68): theirs only once proven by a code — an unproven address on
 * the row is contact data, never an identity.
 */
export function verifiedEmailOf(customer: { email: string | null, emailVerifiedAt: Date | null }): string | null {
  return customer.emailVerifiedAt ? customer.email : null
}

/** Domains whose mailboxes ignore dots in the local part (Gmail; googlemail.com is the same service). */
const DOTLESS_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com'])

/**
 * The mailbox a (normalized) address delivers to, as far as the abuse limits count it (D-P2-68): a `+tag` is dropped,
 * and for Gmail the dots as well, so `a.b+1@gmail.com` and `ab@gmail.com` share one count — an inbox cannot be flooded
 * through its aliases. Only a rate-limit subject: the addresses stay different identities.
 */
export function emailLimitSubject(email: string): string {
  const at = email.lastIndexOf('@')
  const domain = email.slice(at + 1)
  const local = email.slice(0, at)
  const untagged = local.split('+')[0] || local
  return DOTLESS_DOMAINS.has(domain) ? `${untagged.replaceAll('.', '')}@gmail.com` : `${untagged}@${domain}`
}
