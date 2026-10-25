const ARABIC_INDIC_ZERO = 0x0660 // ٠
const PERSIAN_ZERO = 0x06F0 // ۰

/**
 * Arabic-Indic (٠–٩) and Eastern Arabic-Indic / Persian (۰–۹) digits as ASCII. Arabic keyboards type them, so
 * anything people key in as digits — phone numbers, sign-in codes, room numbers — goes through here first.
 */
export function toLatinDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0)
    return String(code - (code >= PERSIAN_ZERO ? PERSIAN_ZERO : ARABIC_INDIC_ZERO))
  })
}
