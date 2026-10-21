import { fileURLToPath } from 'node:url'

/**
 * The shared layer of the three frontends (`extends: ['@hajj/ui']`): Nuxt UI on Tailwind with the design tokens of
 * docs/UI-UX-MASTER-DIRECTION.md §8–§12 replacing the library's look, English and Arabic (RTL) with Western digits
 * and Gregorian dates, server data through TanStack Query, the API client and the shared components.
 */
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  modules: ['@nuxt/ui', '@nuxtjs/i18n'],
  css: [fileURLToPath(new URL('./app/assets/css/main.css', import.meta.url))],
  ui: {
    // Fonts are self-hosted (@fontsource, D7); nothing is fetched from a font CDN at build or run time.
    fonts: false,
    theme: { colors: ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral'] },
  },
  // Light / dark / system, kept in a cookie so the server renders the right theme (no flash, §12).
  colorMode: { preference: 'system', fallback: 'light', storage: 'cookie', storageKey: 'hajj-color-mode' },
  // Icons are bundled from the local Lucide set: no request to an icon API.
  icon: { serverBundle: { collections: ['lucide'] }, clientBundle: { scan: true } },
  i18n: {
    strategy: 'no_prefix',
    defaultLocale: 'en',
    locales: [
      { code: 'en', language: 'en-GB', dir: 'ltr', file: 'en.json', name: 'English' },
      { code: 'ar', language: 'ar-SA', dir: 'rtl', file: 'ar.json', name: 'العربية' },
    ],
    detectBrowserLanguage: { useCookie: true, cookieKey: 'hajj-locale', redirectOn: 'root' },
    vueI18n: './i18n.config.ts',
  },
  runtimeConfig: {
    /**
     * Where the app's `/api/**` goes (server/api/[...path].ts): the API's internal origin (`NUXT_API_PROXY_TARGET`),
     * the path prefixes this app may use (set by each app), and whether this app sits behind one trusted proxy
     * (`NUXT_API_PROXY_TRUST_PROXY`) that sets `X-Forwarded-For`.
     */
    apiProxy: { target: 'http://localhost:3000', allow: [] as string[], trustProxy: false },
  },
  typescript: { strict: true },
})
