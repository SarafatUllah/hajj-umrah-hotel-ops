<script setup lang="ts">
import { holdLeft } from '../utils/hold'

/**
 * How long a hold still keeps its rooms (v7 §10, §36): minutes, then hours, then days — an agency's ten minutes and
 * an individual's day-long request alike — a warning within the last day. The server's expiry decides; the browser
 * clock only paces the display (a hold the server already expired reads EXPIRED on the next answer). `ended` fires
 * once the time is up — at once when the page opens on a hold already past.
 */
const props = defineProps<{ until: string }>()
const emit = defineEmits<{ ended: [] }>()
const { t } = useI18n()
const TICK_MS = 15_000
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, TICK_MS) })
onBeforeUnmount(() => clearInterval(timer))
const left = computed(() => holdLeft(props.until, now.value))
const KEYS = { minute: 'hold.minutesLeft', hour: 'hold.hoursLeft', day: 'hold.daysLeft' } as const
watch(() => left.value.count, (count) => { if (count === 0) emit('ended') }, { immediate: true })
</script>

<template>
  <UAlert v-if="left.count > 0" :color="left.urgent ? 'warning' : 'info'" variant="soft" icon="i-lucide-clock" :title="t(KEYS[left.unit], left.count)" aria-live="polite" />
  <UAlert v-else color="warning" variant="soft" icon="i-lucide-timer-off" :title="t('hold.ended')" role="status" />
</template>
