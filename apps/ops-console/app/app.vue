<script setup lang="ts">
const uiLocale = useDocumentLocale()
const { t } = useI18n()
useHead({ titleTemplate: title => (title ? `${title} · ${t('console.name')}` : t('console.name')) })
</script>

<template>
  <UApp :locale="uiLocale">
    <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-(--surface-1) focus:p-3">
      {{ t('common.skipToContent') }}
    </a>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
