<script setup lang="ts">
/** The receipt's check-in code (v7 §17, §21): the random token only, drawn in the browser (the token as text if it cannot be). */
defineProps<{ token: string, bookingNo: string }>()
const { t } = useI18n()
</script>

<template>
  <figure class="flex flex-col items-center gap-2">
    <QrCode :value="token" :alt="t('receipt.qrAlt', { no: bookingNo })" />
    <figcaption class="text-small text-(--fg-muted)">{{ t('receipt.note') }}</figcaption>
  </figure>
</template>
