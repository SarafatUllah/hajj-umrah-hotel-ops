import { Algorithm, hash, verify } from '@node-rs/argon2'

// OWASP-recommended minimum for Argon2id (also this package's defaults —
// set explicitly so the policy is documented and stable if defaults change).
const HASH_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS)
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    // Cost/salt/version parameters are embedded in the PHC-formatted stored
    // hash itself, so verify() does not need HASH_OPTIONS repeated here —
    // this also means a future change to HASH_OPTIONS never breaks
    // verification of hashes created under the old parameters.
    return await verify(storedHash, password)
  } catch {
    return false
  }
}
