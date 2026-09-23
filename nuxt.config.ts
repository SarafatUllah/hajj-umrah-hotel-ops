export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  modules: ['@nuxt/eslint', 'nuxt-auth-utils'],
  // Nuxt's generated app-level tsconfig (.nuxt/tsconfig.json) does not
  // include `server/**/*` directly, but `nuxt typecheck` still pulls
  // individual server files into that same program (via nitro's
  // auto-import type generation and nuxt-auth-utils' own included route
  // handlers). Without `server/**/*` also listed here, those files get
  // checked without our `server/types/auth.d.ts` module augmentation for
  // '#auth-utils' in scope, so `UserSession.permissions/allHotels/hotelIds`
  // fall back to the library's `[key: string]: unknown` index signature.
  // Forcing the server folder into this config's `include` keeps the
  // augmentation visible everywhere the server files are type-checked.
  typescript: {
    tsConfig: {
      include: ['../server/**/*'],
    },
  },
})
