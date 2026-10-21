<script setup lang="ts">
import QRCode from 'qrcode'

/** The receipt's check-in code (v7 §17, §21): the random token only, drawn in the browser (the token as text if it cannot be). */
const props = defineProps<{ token: string, bookingNo: string }>()
const { t } = useI18n()
const image = ref<string | null>(null)
const failed = ref(false)
watch(() => props.token, async (token) => {
  image.value = null
  failed.value = false
  try {
    const drawn = await QRCode.toDataURL(token, { margin: 1, width: 224, errorCorrectionLevel: 'M' })
    if (token === props.token) image.value = drawn
  }
  catch {
    if (token === props.token) failed.value = true
  }
}, { immediate: true })
</script>

<template>
  <figure class="flex flex-col items-center gap-2">
    <img v-if="image" :src="image" :alt="t('receipt.qrAlt', { no: bookingNo })" width="224" height="224" class="rounded-md bg-white p-2">
    <p v-else-if="failed" class="tabular break-all text-small" dir="ltr">{{ token }}</p>
    <USkeleton v-else class="size-56" />
    <figcaption class="text-small text-(--fg-muted)">{{ t('receipt.note') }}</figcaption>
  </figure>
</template>
