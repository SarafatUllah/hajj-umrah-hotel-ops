// @ts-check
import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

// Same base rules as the Nuxt app (`@nuxt/eslint` builds on this config).
export default createConfigForNuxt({ features: { standalone: true } })
