import { createPiiCipher, parseKeyRing, parseLookupKey, type PiiCipher } from '../security/piiCrypto'
import { getEnv } from './env'

let cipher: PiiCipher | null = null

/** The process-wide PII cipher built from PII_ENCRYPTION_KEYS / PII_LOOKUP_KEY (validated at startup by getEnv). */
export function usePiiCipher(): PiiCipher {
  if (!cipher) {
    const env = getEnv()
    cipher = createPiiCipher(parseKeyRing(env.PII_ENCRYPTION_KEYS), parseLookupKey(env.PII_LOOKUP_KEY))
  }
  return cipher
}

/** Test hook: forget the cached cipher (after changing the environment). */
export function resetPiiCipher(): void {
  cipher = null
}
