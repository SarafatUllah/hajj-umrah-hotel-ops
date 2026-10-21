<script setup lang="ts">
/**
 * How long a hold still keeps its rooms (v7 §10), counting down by the minute. The server's expiry decides; the
 * browser clock only paces the display (a hold the server already expired reads EXPIRED on the next answer). `ended`
 * fires once the time is up — at once when the page opens on a hold already past.
 */
const props = defineProps<{ until: string }>()
const emit = defineEmits<{ ended: [] }>()
const { t } = useI18n()
const MS_PER_MINUTE = 60_000
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, MS_PER_MINUTE / 4) })
onBeforeUnmount(() => clearInterval(timer))
const minutes = computed(() => Math.max(0, Math.ceil((new Date(props.until).getTime() - now.value) / MS_PER_MINUTE)))
watch(minutes, (left) => { if (left === 0) emit('ended') }, { immediate: true })
</script>

<template>
  <UAlert v-if="minutes > 0" color="info" variant="soft" icon="i-lucide-clock" :title="t('hold.minutesLeft', minutes)" aria-live="polite" />
  <UAlert v-else color="warning" variant="soft" icon="i-lucide-timer-off" :title="t('hold.ended')" role="status" />
</template>
