<script setup lang="ts">
import type { CapacityTimelineResult } from '@hajj/contracts/types/inventory'
import { addDays } from '@hajj/contracts/utils/dates'
import { signed, timelineOf } from '../../utils/inventory'

/**
 * A room's capacity over time (§29): one ribbon — "Normal", then a season, then "Normal" again — each part with Haji
 * (large) and beds (small), the change at each boundary, a season returning automatically, nights out of inventory
 * hatched, today marked. It runs in reading order (right to left in Arabic). A list on small screens. The server
 * decides every capacity; the window moves by six months.
 */
const props = defineProps<{ hotelId: string, roomId: string, today: string }>()
const { t } = useI18n()
const api = useApi()
const format = useFormat()
const BEFORE_TODAY = 60
const WINDOW_NIGHTS = 400
const STEP = 182
const from = ref(addDays(props.today, -BEFORE_TODAY))
const to = computed(() => addDays(from.value, WINDOW_NIGHTS - 1))
const timeline = useApiQuery(
  () => ['room-timeline', props.hotelId, props.roomId, from.value],
  () => api<CapacityTimelineResult>(`/hotels/${props.hotelId}/rooms/${props.roomId}/capacity-timeline`, { query: { from: from.value, to: to.value } }),
)
const parts = computed(() => (timeline.data.value ? timelineOf(timeline.data.value) : []))
const labelOf = (index: number) => {
  const part = parts.value[index]!
  if (part.kind === 'GAP') return t('timeline.notInInventory')
  return part.kind === 'SEASON' ? part.seasonName ?? t('timeline.season') : t('timeline.normal')
}
/** After a season, the normal capacity comes back by itself: said so, so nobody resets anything. */
const returns = (index: number) => parts.value[index]?.kind === 'NORMAL' && parts.value[index - 1]?.kind === 'SEASON'
</script>

<template>
  <section aria-labelledby="timeline-heading" class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 id="timeline-heading" class="text-section">{{ t('timeline.title') }}</h2>
      <div class="flex gap-1">
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-chevron-left" :ui="{ leadingIcon: 'rtl:-scale-x-100' }" @click="from = addDays(from, -STEP)">{{ t('timeline.earlier') }}</UButton>
        <UButton size="sm" color="neutral" variant="outline" trailing-icon="i-lucide-chevron-right" :ui="{ trailingIcon: 'rtl:-scale-x-100' }" @click="from = addDays(from, STEP)">{{ t('timeline.later') }}</UButton>
      </div>
    </div>
    <ErrorState v-if="timeline.error.value" :error="timeline.error.value" @retry="timeline.refetch()" />
    <USkeleton v-else-if="timeline.isPending.value" class="h-24" />
    <template v-else>
      <p class="text-small text-(--fg-muted)">{{ format.date(from) }} – {{ format.date(to) }}</p>
      <ol class="hidden overflow-x-auto md:flex" :aria-label="t('timeline.title')">
        <li
          v-for="(part, index) in parts"
          :key="part.from"
          class="flex min-w-24 flex-col gap-1 border border-(--border) p-2 text-small"
          :class="[
            part.kind === 'SEASON' ? 'border-t-[3px] border-t-(--season) bg-(--season-soft)' : part.kind === 'GAP' ? 'bg-[repeating-linear-gradient(45deg,transparent_0_6px,var(--border)_6px_7px)] text-(--fg-muted)' : 'bg-(--surface-1)',
            { 'opacity-60': part.past, 'ring-2 ring-(--primary) ring-inset': part.current },
          ]"
          :style="{ flexGrow: part.nights, flexBasis: 0 }"
        >
          <span class="truncate font-medium"><bdi>{{ labelOf(index) }}</bdi><span v-if="part.current" class="ms-1 text-(--primary)">· {{ t('timeline.now') }}</span></span>
          <template v-if="part.kind !== 'GAP'">
            <span class="text-section tabular">{{ t('capacity.haji', { count: part.sellableCapacity }) }}</span>
            <span class="tabular text-(--fg-muted)">{{ t('capacity.beds', { count: part.physicalBeds }, part.physicalBeds ?? 0) }}</span>
            <span v-if="part.deltaSellable" class="tabular"><bdi dir="ltr">{{ signed(part.deltaSellable) }}</bdi> {{ t('capacity.hajiShort') }}</span>
            <span v-if="returns(index)" class="text-(--fg-muted)">{{ t('timeline.returns') }}</span>
          </template>
          <span class="mt-auto tabular text-(--fg-muted)">{{ format.date(part.from, 'short') }} – {{ format.date(part.to) }}</span>
        </li>
      </ol>
      <ol class="flex flex-col gap-3 md:hidden">
        <li v-for="(part, index) in parts" :key="part.from" class="flex gap-3" :class="{ 'opacity-60': part.past }">
          <span class="mt-1 size-2.5 shrink-0 rounded-full" :class="part.kind === 'SEASON' ? 'bg-(--season)' : part.kind === 'GAP' ? 'border border-(--fg-muted)' : 'bg-(--fg-muted)'" aria-hidden="true" />
          <div class="flex flex-col">
            <span class="text-small text-(--fg-muted)">{{ format.date(part.from, 'short') }} – {{ format.date(part.to) }}<template v-if="part.current"> · {{ t('timeline.now') }}</template></span>
            <span class="font-medium"><bdi>{{ labelOf(index) }}</bdi></span>
            <CapacityValue v-if="part.kind !== 'GAP'" :haji="part.sellableCapacity" :beds="part.physicalBeds" />
            <span v-if="returns(index)" class="text-small text-(--fg-muted)">{{ t('timeline.returns') }}</span>
          </div>
        </li>
      </ol>
    </template>
  </section>
</template>
