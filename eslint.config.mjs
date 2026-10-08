// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

// Layering (the same rules are enforced independently by
// tests/unit/architecture/layering.test.ts). A later block's
// `no-restricted-imports` replaces an earlier one for the files it matches,
// so each block lists every pattern that applies to its files.
const TRUSTED_MINTING = { group: ['**/security/*', '**/security/**'], importNamePattern: '^trusted', message: 'Scopes are minted only by server/security, db/seed and tests.' }
const IDENTITY_MINTING = { group: ['**/security/*', '**/security/**'], importNames: ['scopeFromIdentity'], message: 'scopeFromIdentity is used only inside server/security; receive a scope instead.' }

export default withNuxt(
  // Ignore .remember (Claude Code plugin state directory, not part of this project)
  {
    ignores: ['.remember/'],
  },
  // Everywhere outside the trusted minters: no scope minting at all.
  {
    files: ['**/*.{ts,mts,cts,js,mjs,cjs,vue}'],
    ignores: ['server/security/**', 'db/seed/**', 'tests/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [TRUSTED_MINTING, IDENTITY_MINTING] }],
    },
  },
  // Seeds and tests may use trusted*, but not scopeFromIdentity.
  {
    files: ['db/seed/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [IDENTITY_MINTING] }],
    },
  },
  // Only repositories build queries.
  {
    files: ['server/services/**/*.ts', 'server/api/**/*.ts', 'server/domain/**/*.ts', 'server/utils/**/*.ts', 'shared/**/*.ts'],
    ignores: ['server/utils/db.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['drizzle-orm', 'drizzle-orm/*'], message: 'Only repositories may build queries.' },
        { group: ['**/db/schema', '**/db/schema/*', '**/db/client'], message: 'Go through a repository.' },
        TRUSTED_MINTING,
        IDENTITY_MINTING,
      ] }],
    },
  },
)
