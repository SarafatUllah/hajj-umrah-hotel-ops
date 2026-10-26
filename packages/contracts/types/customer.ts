/**
 * A signed-in customer as the public site sees them: the phone and/or the verified e-mail address they sign in with
 * (D-P2-68: at least one; a phone account and an e-mail account are separate customers).
 */
export interface CustomerMe { id: string, phone: string | null, email: string | null, fullName: string }

/** A code was sent (the same answer whether or not the phone or the address has an account). */
export interface OtpChallengeIssued { challengeId: string, expiresInSeconds: number }

/** `POST /api/customer/auth/otp/verify`: signed in; `isNew` = the account was just created. */
export interface CustomerSignIn { customer: CustomerMe, isNew: boolean }
