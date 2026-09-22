// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

// Ignore .remember (Claude Code plugin state directory, not part of this project)
export default withNuxt({
  ignores: ['.remember/'],
})
