// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  // Ignore .remember (Claude Code plugin state directory, not part of this project)
  {
    ignores: ['.remember/'],
  },
  // Layering: only repositories build queries, and scopes are minted only by
  // server/security, db/seed and tests. The same rules are enforced
  // independently by tests/unit/architecture/layering.test.ts.
  {
    files: ['server/services/**/*.ts', 'server/api/**/*.ts', 'server/domain/**/*.ts', 'server/utils/**/*.ts', 'shared/**/*.ts'],
    ignores: ['server/utils/db.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['drizzle-orm', 'drizzle-orm/*'], message: 'Only repositories may build queries.' },
        { group: ['**/db/schema', '**/db/schema/*', '**/db/client'], message: 'Go through a repository.' },
        { group: ['**/security/scope'], importNamePattern: '^trusted', message: 'Scopes are minted only by server/security, db/seed and tests.' },
      ] }],
    },
  },
)
