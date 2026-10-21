<script setup lang="ts">
/** The language toggle (§7): shows the OTHER language in its own script, never a flag; the choice is remembered. */
const { locale, locales, setLocale, setLocaleCookie } = useI18n()
const other = computed(() => locales.value.find(l => l.code !== locale.value))

async function switchTo(code: typeof locale.value) {
  // With no locale in the URL, the cookie is what brings the language back on the next visit.
  setLocaleCookie(code)
  await setLocale(code)
}
</script>

<template>
  <UButton v-if="other" color="neutral" variant="ghost" icon="i-lucide-languages" :lang="other.code" @click="switchTo(other.code)">
    {{ other.name }}
  </UButton>
</template>
