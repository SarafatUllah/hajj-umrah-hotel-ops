/**
 * The agency portal (v7 §6): signed-in work, rendered in the browser; only sign-in and registration are server-rendered.
 * Its `/api/**` reaches the API through the shared layer — the agency and public endpoints only.
 */
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  extends: ['@hajj/ui'],
  devtools: { enabled: false },
  routeRules: {
    '/**': { ssr: false },
    '/login': { ssr: true },
    '/register': { ssr: true },
  },
  runtimeConfig: {
    apiProxy: { allow: ['/api/agency/', '/api/public/'] },
    public: {
      session: { mePath: '/agency/auth/me', signOutPath: '/agency/auth/logout', signOutEverywherePath: '', signInPath: '/login', homePath: '/' },
      /** The organization (hotel operator) this portal belongs to (`NUXT_PUBLIC_ORGANIZATION_SLUG`). */
      organizationSlug: 'demo',
      siteName: 'Agency portal',
    },
  },
  i18n: {
    locales: [
      { code: 'en', file: 'en.json' },
      { code: 'ar', file: 'ar.json' },
    ],
  },
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }, { name: 'robots', content: 'noindex' }],
    },
  },
  typescript: { strict: true },
})
