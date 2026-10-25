<script setup lang="ts">
/**
 * Sellable Haji capacity per night (§21.2 outlook): one series, so one quiet hue and no legend — the heading names
 * it. Thin bars from the baseline with a surface gap, a tooltip per night, a sentence for screen readers (the lowest
 * night) and the same figures as a table on demand.
 */
const props = defineProps<{ days: Array<{ date: string, value: number }> }>()
const { t } = useI18n()
const format = useFormat()
const asTable = ref(false)
const HEIGHT = 120
const GAP = 2
const max = computed(() => Math.max(1, ...props.days.map(d => d.value)))
const lowest = computed(() => props.days.reduce<{ date: string, value: number } | null>((low, day) => (!low || day.value < low.value ? day : low), null))
const barWidth = computed(() => Math.max(2, Math.floor(720 / Math.max(1, props.days.length)) - GAP))
const width = computed(() => props.days.length * (barWidth.value + GAP))
const hovered = ref<number | null>(null)
</script>

<template>
  <div class="flex flex-col gap-2">
    <p v-if="lowest" class="text-small text-(--fg-muted)">{{ t('overview.lowest', { value: lowest.value, date: format.date(lowest.date) }) }}</p>
    <div v-if="!asTable" class="relative overflow-x-auto">
      <svg :viewBox="`0 0 ${width} ${HEIGHT}`" :width="width" :height="HEIGHT" role="img" :aria-label="t('overview.outlookLabel')" class="block rtl:-scale-x-100">
        <line x1="0" :x2="width" :y1="HEIGHT - 0.5" :y2="HEIGHT - 0.5" stroke="var(--border)" />
        <rect
          v-for="(day, index) in days"
          :key="day.date"
          :x="index * (barWidth + GAP)"
          :y="HEIGHT - Math.max(1, (day.value / max) * (HEIGHT - 8))"
          :width="barWidth"
          :height="Math.max(1, (day.value / max) * (HEIGHT - 8))"
          rx="2"
          :fill="hovered === index ? 'var(--fg-muted)' : 'var(--fg-disabled)'"
          @mouseenter="hovered = index"
          @mouseleave="hovered = null"
        >
          <title>{{ format.date(day.date) }}: {{ t('overview.haji', { count: day.value }) }}</title>
        </rect>
      </svg>
      <p v-if="hovered !== null" class="pointer-events-none mt-1 text-small tabular" aria-hidden="true">
        {{ format.date(days[hovered]!.date, 'long') }} · {{ t('overview.haji', { count: days[hovered]!.value }) }}
      </p>
    </div>
    <table v-else class="w-full text-small">
      <thead class="text-caption text-(--fg-muted)"><tr><th scope="col" class="py-1 text-start">{{ t('overview.night') }}</th><th scope="col" class="py-1 text-end">{{ t('overview.capacity') }}</th></tr></thead>
      <tbody class="divide-y divide-(--border)">
        <tr v-for="day in days" :key="day.date"><td class="py-1 tabular">{{ format.date(day.date, 'long') }}</td><td class="py-1 text-end tabular">{{ day.value }}</td></tr>
      </tbody>
    </table>
    <UButton color="neutral" variant="link" size="sm" class="self-start" @click="asTable = !asTable">{{ asTable ? t('overview.asChart') : t('overview.asTable') }}</UButton>
  </div>
</template>
