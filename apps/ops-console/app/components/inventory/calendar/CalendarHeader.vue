<script setup lang="ts">
import type { DailySummary } from '@hajj/contracts/types/inventory'
import { addDays, toEpochDay } from '@hajj/contracts/utils/dates'
import { monthsOf, placeOf } from '../../../utils/calendar'

/**
 * The calendar's header rows (§31.2), kept in view: months and seasons (for the eye; each cell names its season),
 * the nights (column headers) and the sellable rooms per night, placed by date — never by position, so a summary
 * still loading for the previous range cannot sit under the wrong night.
 */
const props = defineProps<{
  from: string
  nights: number
  columnWidth: number
  today: string
  seasons: Array<{ id: string, name: string, startDate: string, endDate: string }>
  summary: DailySummary[]
}>()
const { t, locale } = useI18n()
const format = useFormat()
const months = computed(() => {
  const name = new Intl.DateTimeFormat(localeTag(locale.value), { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return monthsOf(props.from, props.nights).map(m => ({ ...m, name: name.format(new Date(`${m.month}-01T00:00:00Z`)) }))
})
const days = computed(() => {
  const weekday = new Intl.DateTimeFormat(localeTag(locale.value), { weekday: 'narrow', timeZone: 'UTC' })
  const todayIndex = toEpochDay(props.today) - toEpochDay(props.from)
  return Array.from({ length: props.nights }, (_, index) => {
    const night = addDays(props.from, index)
    return { night, column: index + 2, day: Number(night.slice(8)), weekday: weekday.format(new Date(`${night}T00:00:00Z`)), label: format.date(night, 'long'), isToday: index === todayIndex }
  })
})
const seasonBars = computed(() => props.seasons.flatMap((s) => {
  const place = placeOf({ from: s.startDate, to: s.endDate }, props.from, props.nights)
  return place ? [{ ...s, place }] : []
}))
const sellable = computed(() => props.summary.flatMap((day) => {
  const place = placeOf({ from: day.date, to: day.date }, props.from, props.nights)
  return place ? [{ ...day, column: place.column + 1 }] : []
}))
</script>

<template>
  <div aria-hidden="true" class="contents">
    <div class="sticky start-0 top-0 z-30 bg-(--surface-1)" style="grid-row: 1; grid-column: 1" />
    <div v-for="month in months" :key="month.month" class="sticky top-0 z-20 truncate border-b border-(--border) bg-(--surface-1) px-1 text-caption" :style="{ gridRow: 1, gridColumn: `${month.column + 1} / span ${month.span}` }">
      {{ month.name }}
    </div>
    <div class="sticky start-0 top-6 z-30 bg-(--surface-1) px-2 text-caption text-(--fg-muted)" style="grid-row: 2; grid-column: 1">{{ t('nav.seasons') }}</div>
    <div v-for="season in seasonBars" :key="season.id" class="sticky top-6 z-10 mx-px my-1 truncate rounded-sm bg-(--season-soft) px-1 text-caption text-(--season)" :style="{ gridRow: 2, gridColumn: `${season.place.column + 1} / span ${season.place.span}` }" :title="season.name">
      <bdi>{{ season.name }}</bdi>
    </div>
  </div>
  <div role="row" aria-rowindex="1" class="contents">
    <div role="columnheader" aria-colindex="1" class="sticky start-0 top-12 z-30 border-b border-(--border) bg-(--surface-1) px-2 py-1 text-caption text-(--fg-muted)" style="grid-row: 3; grid-column: 1">{{ t('rooms.room') }}</div>
    <div v-for="day in days" :key="day.night" role="columnheader" :aria-colindex="day.column" :aria-label="day.label" class="sticky top-12 z-20 flex flex-col items-center justify-center border-b border-(--border) bg-(--surface-1) text-caption tabular" :class="{ 'text-(--primary)': day.isToday }" :style="{ gridRow: 3, gridColumn: day.column }">
      <span>{{ day.day }}</span>
      <span v-if="columnWidth >= 28" class="text-[10px] text-(--fg-muted)">{{ day.weekday }}</span>
    </div>
  </div>
  <div role="row" aria-rowindex="2" class="contents">
    <div role="rowheader" aria-colindex="1" class="sticky start-0 top-[88px] z-30 border-b border-(--border) bg-(--surface-1) px-2 text-caption text-(--fg-muted)" style="grid-row: 4; grid-column: 1">{{ t('calendar.sellable') }}</div>
    <div
      v-for="day in sellable"
      :key="day.date"
      role="gridcell"
      :aria-colindex="day.column"
      class="sticky top-[88px] z-20 flex items-center justify-center border-b border-(--border) bg-(--surface-1) text-caption tabular"
      :style="{ gridRow: 4, gridColumn: day.column }"
      :title="t('calendar.summaryTip', { inventory: day.roomsInInventory, oos: day.outOfService, maintenance: day.maintenance, blocked: day.operationalBlock, haji: day.sellableRoomCapacity })"
    >
      <template v-if="columnWidth >= 28">{{ day.sellableRooms }}</template>
      <span v-else class="sr-only">{{ day.sellableRooms }}</span>
    </div>
  </div>
</template>
