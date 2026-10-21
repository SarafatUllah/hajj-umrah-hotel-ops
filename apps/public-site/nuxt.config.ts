/**
 * The public site (v7 §6, §41: server-rendered for search engines). Its `/api/**` is forwarded to the API by the
 * shared layer (only the public and customer endpoints), so the customer's session cookie is first-party; the API
 * lists this site's origin in `ALLOWED_ORIGINS` and trusts it as its proxy.
 */
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  extends: ['@hajj/ui'],
  devtools: { enabled: false },
  routeRules: {
    // Signed-in pages change per visitor: rendered in the browser (their pages also ask search engines not to index them).
    '/bookings/**': { ssr: false },
    '/book/**': { ssr: false },
    '/account': { ssr: false },
  },
  runtimeConfig: {
    apiProxy: { allow: ['/api/public/', '/api/customer/'] },
    public: {
      session: { mePath: '/customer/auth/me', signOutPath: '/customer/auth/logout', signOutEverywherePath: '/customer/auth/logout-all', signInPath: '/sign-in', homePath: '/bookings' },
      /** The organization whose hotels this site sells (`NUXT_PUBLIC_ORGANIZATION_SLUG`). */
      organizationSlug: 'demo',
      /** Cloudflare Turnstile's site key (`NUXT_PUBLIC_TURNSTILE_SITE_KEY`): the bot check before a code is texted; empty = none. */
      turnstileSiteKey: '',
      siteName: 'Hajj & Umrah Stays',
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
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },
  typescript: { strict: true },
})
