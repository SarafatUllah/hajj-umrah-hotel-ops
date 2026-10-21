<script setup lang="ts">
import { loadTurnstile, type TurnstileApi } from '../utils/turnstile'

/**
 * The bot check before a code is texted (v7 §21; Cloudflare Turnstile, `NUXT_PUBLIC_TURNSTILE_SITE_KEY` with
 * `CAPTCHA_DRIVER=turnstile` on the API). Nothing shows without a key. Its token (the model) is good for one request:
 * `reset()` asks for a new one after each.
 */
const token = defineModel<string | null>({ default: null })
const { t, locale } = useI18n()
const siteKey = String(useRuntimeConfig().public.turnstileSiteKey ?? '')
const container = ref<HTMLElement | null>(null)
const failed = ref(false)
let turnstile: TurnstileApi | undefined
let widgetId: string | undefined

onMounted(async () => {
  if (!siteKey || !container.value) return
  try {
    turnstile = await loadTurnstile()
    widgetId = turnstile.render(container.value, {
      'sitekey': siteKey,
      'language': locale.value,
      'callback': (value) => { token.value = value },
      'expired-callback': () => { token.value = null },
      'error-callback': () => { token.value = null },
    })
  }
  catch {
    failed.value = true
  }
})
onBeforeUnmount(() => { if (turnstile && widgetId) turnstile.remove(widgetId) })

function reset(): void {
  token.value = null
  if (turnstile && widgetId) turnstile.reset(widgetId)
}
defineExpose({ reset })
</script>

<template>
  <div v-if="siteKey" class="flex flex-col gap-2">
    <div ref="container" />
    <p v-if="failed" class="text-small text-(--danger)" role="alert">{{ t('signIn.checkFailed') }}</p>
  </div>
</template>
