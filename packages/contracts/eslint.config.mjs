// @ts-check
import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

// Same base rules as the Nuxt app (`@nuxt/eslint` builds on this config), plus the layering rule
// that used to cover `shared/**` in apps/api: contracts are pure and framework-free, so they never
// build queries or reach into the database package (also enforced by apps/api's layering test).
export default createConfigForNuxt({ features: { standalone: true } }).append({
  files: ['**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', { patterns: [
      { group: ['drizzle-orm', 'drizzle-orm/*'], message: 'Contracts are pure: only repositories may build queries.' },
      { group: ['@hajj/db', '@hajj/db/*'], message: 'Contracts never depend on the database package.' },
      { group: ['**/apps/**', '**/server/**'], message: 'Contracts never import application code (security scopes, services, repositories).' },
    ] }],
  },
})
