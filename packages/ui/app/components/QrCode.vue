<script setup lang="ts">
import QRCode from 'qrcode'

/**
 * A QR code drawn in the browser (nothing is sent anywhere to draw it). If it cannot be drawn, the value itself shows
 * as text, so it can still be copied or typed.
 */
const props = defineProps<{ value: string, alt: string, size?: number }>()
const DEFAULT_SIZE = 224
const width = computed(() => props.size ?? DEFAULT_SIZE)
const image = ref<string | null>(null)
const failed = ref(false)
watch(() => props.value, async (value) => {
  image.value = null
  failed.value = false
  try {
    const drawn = await QRCode.toDataURL(value, { margin: 1, width: width.value, errorCorrectionLevel: 'M' })
    if (value === props.value) image.value = drawn
  }
  catch {
    if (value === props.value) failed.value = true
  }
}, { immediate: true })
</script>

<template>
  <img v-if="image" :src="image" :alt="alt" :width="width" :height="width" class="rounded-md bg-white p-2">
  <p v-else-if="failed" class="tabular break-all text-small" dir="ltr">{{ value }}</p>
  <USkeleton v-else :style="{ width: `${width}px`, height: `${width}px` }" />
</template>
