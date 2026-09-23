import { hash, verify } from '@node-rs/argon2'

// OWASP-recommended minimum for Argon2id (also this package's defaults —
// set explicitly so the policy is documented and stable if defaults change).
//
// `algorithm: 2` is `Algorithm.Argon2id` from '@node-rs/argon2'. That enum
// is declared `export declare const enum Algorithm` in the package's
// generated .d.ts (an *ambient* const enum), which TypeScript refuses to
// import as a value under `verbatimModuleSyntax` (on by default in Nuxt's
// generated tsconfig): "Cannot access ambient const enums when
// 'verbatimModuleSyntax' is enabled." Numeric enum members accept a raw
// number, so the literal is used directly instead of the enum reference.
const HASH_OPTIONS = {
  algorithm: 2,
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
