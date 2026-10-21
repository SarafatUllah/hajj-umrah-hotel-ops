import { ar, en } from '@nuxt/ui/locale'

/**
 * The page follows the chosen language (§13): `<html lang dir>` and Nuxt UI's own strings and direction. Returns the
 * Nuxt UI locale for `<UApp :locale>`.
 */
export function useDocumentLocale() {
  const { locale } = useI18n()
  const uiLocale = computed(() => (locale.value === 'ar' ? ar : en))
  useHead({ htmlAttrs: { lang: () => locale.value, dir: () => uiLocale.value.dir } })
  return uiLocale
}
