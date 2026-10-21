/**
 * The staff ops console (UI-UX-MASTER-DIRECTION §41, D2): the signed-in operational pages render in the browser; only
 * sign-in renders on the server. Its `/api/**` reaches the API through the shared layer — the staff endpoints only
 * (never the agency or customer ones), plus the gated demo sign-in.
 */
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  extends: ['@hajj/ui'],
  devtools: { enabled: false },
  css: ['~/assets/css/console.css'],
  // Components are named by file, not folder (`HotelSwitcher`, not `ShellHotelSwitcher`); folders only group them.
  components: [{ path: '~/components', pathPrefix: false }],
  routeRules: {
    '/**': { ssr: false },
    '/login': { ssr: true },
  },
  runtimeConfig: {
    apiProxy: {
      allow: [
        '/api/auth/', '/api/users/', '/api/hotels', '/api/room-types', '/api/capacity/', '/api/stays/', '/api/bookings',
        '/api/check-in/', '/api/quotes', '/api/agencies', '/api/booking-settings', '/api/admin/', '/api/public/demo-sign-in',
      ],
    },
    public: {
      session: { mePath: '/auth/me', signOutPath: '/auth/logout', signOutEverywherePath: '', signInPath: '/login', homePath: '/' },
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
