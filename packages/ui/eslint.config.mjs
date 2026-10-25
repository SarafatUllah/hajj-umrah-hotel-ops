// @ts-check
import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

// The same base rules as the API; the shared layer never reaches into server code or the database.
export default createConfigForNuxt({ features: { standalone: true } }).append({
  ignores: ['.nuxt/', '.output/'],
}, {
  files: ['**/*.{ts,vue}'],
  rules: {
    'no-restricted-imports': ['error', { patterns: [
      { group: ['@hajj/db', '@hajj/db/*', 'drizzle-orm', 'drizzle-orm/*'], message: 'The frontends never reach the database.' },
      { group: ['**/apps/api/**', '**/api/server/**'], message: 'The frontends talk to the API over HTTP only; shared types live in @hajj/contracts.' },
    ] }],
  },
})
