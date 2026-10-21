<script setup lang="ts">
import type { OccupancyDayDto } from '@hajj/contracts/types/occupancy'
import { type FillTone, fillTone, monthGrid } from '../../utils/occupancy'

/**
 * One month of the occupancy calendar (v7 §14). `compact` (the year view): a small square per day coloured by how
 * full it is. Otherwise the month view: per day how full, the rooms and places still free, arrivals and departures.
 * Every day opens the day view; its words (not only its colour) say how full it is.
 */
/** `seasons`: the season names marked on each date (Hajj, Ramadan). */
const props = defineProps<{ month: string, days: ReadonlyMap<string, OccupancyDayDto>, today: string, compact?: boolean, seasons?: ReadonlyMap<string, readonly string[]> }>()
const emit = defineEmits<{ open: [date: string] }>()
const { t, locale } = useI18n()
const format = useFormat()
const weeks = computed(() => monthGrid(props.month))
const title = computed(() => new Intl.DateTimeFormat(localeTag(locale.value), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${props.month}-01T00:00:00Z`)))
const weekdays = computed(() => {
  const name = new Intl.DateTimeFormat(localeTag(locale.value), { weekday: props.compact ? 'narrow' : 'short', timeZone: 'UTC' })
  // 2027-06-06 is a Sunday: the week starts there.
  return Array.from({ length: 7 }, (_, index) => name.format(new Date(Date.UTC(2027, 5, 6 + index))))
})
const TONE: Record<FillTone, string> = {
  low: 'bg-(--success-soft) text-(--success)',
  mid: 'bg-(--warning-soft) text-(--warning)',
  high: 'bg-(--danger-soft) text-(--danger)',
}
const toneOf = (day: OccupancyDayDto | undefined) => (day && day.seats.total > 0 ? TONE[fillTone(day.occupancyPercent)] : 'bg-(--surface-2) text-(--fg-muted)')
function labelOf(date: string): string {
  const day = props.days.get(date)
  const seasons = props.seasons?.get(date) ?? []
  const said = !day || !day.seats.total
    ? t('occupancy.noRoomsLabel', { date: format.date(date, 'long') })
    : t('occupancy.dayLabel', { date: format.date(date, 'long'), percent: day.occupancyPercent, taken: day.seats.pilgrims + day.seats.held, total: day.seats.total, arrivals: day.arrivals, departures: day.departures })
  return seasons.length ? `${said} ${seasons.join(t('calendar.separator'))}` : said
}
</script>

<template>
  <section class="flex flex-col gap-2" :aria-label="title">
    <h3 class="font-medium" :class="compact ? 'text-small' : 'text-subsection'">{{ title }}</h3>
    <div class="grid grid-cols-7 gap-1" role="presentation">
      <span v-for="(name, index) in weekdays" :key="index" class="text-center text-caption text-(--fg-muted)" aria-hidden="true">{{ name }}</span>
      <template v-for="(week, w) in weeks" :key="w">
        <template v-for="(date, d) in week" :key="`${w}-${d}`">
          <span v-if="!date" aria-hidden="true" />
          <button
            v-else
            type="button"
            class="rounded-sm text-start tabular outline-offset-1 hover:brightness-95 focus-visible:outline-2 focus-visible:outline-(--focus-ring)"
            :class="[toneOf(days.get(date)), compact ? 'aspect-square p-0.5 text-center text-[10px]' : 'flex min-h-24 flex-col gap-0.5 p-2 text-caption', { 'ring-2 ring-(--primary)': date === today, 'border-b-2 border-b-(--season)': seasons?.has(date) }]"
            :aria-label="labelOf(date)"
            :title="compact ? labelOf(date) : undefined"
            @click="emit('open', date)"
          >
            <span class="font-semibold" :class="compact ? '' : 'text-small'">{{ Number(date.slice(8)) }}</span>
            <template v-if="!compact && days.get(date)">
              <span class="text-section">{{ days.get(date)!.occupancyPercent }}%</span>
              <span>{{ t('occupancy.freeRooms', { count: days.get(date)!.rooms.empty }, days.get(date)!.rooms.empty) }}</span>
              <span>{{ t('occupancy.freePlaces', { count: days.get(date)!.seats.empty }, days.get(date)!.seats.empty) }}</span>
              <span v-if="days.get(date)!.arrivals || days.get(date)!.departures" class="flex gap-2">
                <span v-if="days.get(date)!.arrivals" class="flex items-center gap-0.5"><UIcon name="i-lucide-log-in" class="size-3" />{{ days.get(date)!.arrivals }}</span>
                <span v-if="days.get(date)!.departures" class="flex items-center gap-0.5"><UIcon name="i-lucide-log-out" class="size-3" />{{ days.get(date)!.departures }}</span>
              </span>
            </template>
          </button>
        </template>
      </template>
    </div>
  </section>
</template>
