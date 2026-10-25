<script setup lang="ts">
import { keepPreviousData } from '@tanstack/vue-query'
import type { OccupancyRangeDto, OccupancyRoomDto } from '@hajj/contracts/types/occupancy'
import { addDays, eachDate, isValidIsoDate } from '@hajj/contracts/utils/dates'
import { csvOf, monthRange, shiftMonth } from '../../../utils/occupancy'

/**
 * The occupancy calendar (v7 §14, `occupancy.view`): a year of small months coloured by how full each day is (Hajj
 * and Ramadan marked), a month with each day's fill, free rooms and places, arrivals and departures, and a day as
 * floors of rooms — who sleeps where — with its summary, filters, each room's bookings and pilgrims, and the day's
 * list to download. The view lives in the URL (view, year, month, date).
 */
definePageMeta({ middleware: 'auth' })
type View = 'year' | 'month' | 'day'
const VIEWS: readonly View[] = ['year', 'month', 'day']
// Years a calendar can be asked for (outside them a link falls back to today).
const YEAR = /^(19|20|21)\d{2}$/
const MONTH = /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/
const MARKED_KINDS = ['HAJJ', 'RAMADAN']

const { t, locale } = useI18n()
const api = useApi()
const format = useFormat()
const access = useAccess()
const { queryOf, setQuery } = useUrlQuery()
const { hotel, hotelId, ready } = useCurrentHotel()
const allowed = computed(() => ready.value && access.value.canInHotel('occupancy.view', hotelId.value))

const view = computed<View>(() => VIEWS.find(v => v === queryOf('view')) ?? 'month')
const today = computed(() => hotel.value?.today ?? '')
const date = computed(() => {
  const asked = queryOf('date')
  return asked && isValidIsoDate(asked) ? asked : today.value
})
const month = computed(() => {
  const asked = queryOf('month')
  return asked && MONTH.test(asked) ? asked : date.value.slice(0, 7)
})
const year = computed(() => {
  const asked = queryOf('year')
  return asked && YEAR.test(asked) ? asked : month.value.slice(0, 4)
})

const wanted = computed(() => (view.value === 'year' ? { from: `${year.value}-01-01`, to: `${year.value}-12-31` } : monthRange(month.value)))
const range = useApiQuery(
  () => ['occupancy', hotelId.value, wanted.value.from, wanted.value.to],
  () => api<OccupancyRangeDto>(`/hotels/${hotelId.value}/occupancy`, { query: wanted.value }),
  { enabled: computed(() => allowed.value && view.value !== 'day' && !!today.value), placeholderData: keepPreviousData },
)
const days = computed(() => new Map((range.data.value?.days ?? []).map(d => [d.date, d])))
const markedPeriods = computed(() => (range.data.value?.periods ?? []).filter(p => MARKED_KINDS.includes(p.kind)))
/** Each date's marked seasons, by name (said in each day's words, not only drawn). */
const seasons = computed(() => {
  const names = new Map<string, string[]>()
  for (const period of markedPeriods.value) {
    for (const night of eachDate({ from: period.startDate, to: period.endDate })) names.set(night, [...(names.get(night) ?? []), period.name])
  }
  return names
})
const months = computed(() => Array.from({ length: 12 }, (_, index) => `${year.value}-${String(index + 1).padStart(2, '0')}`))
const day = useOccupancyDay(hotelId, date, () => allowed.value && view.value === 'day')

const openDay = (night: string) => setQuery({ view: 'day', date: night, month: undefined, year: undefined })
/**
 * Another view of the same moment: the day shown, else the month's first day (today in this month), else the year's
 * first day (today in this year) — written as the date, so the views never disagree about where they are.
 */
function show(next: View): void {
  const thisMonth = today.value.slice(0, 7)
  const anchor = view.value === 'day'
    ? date.value
    : view.value === 'month'
      ? (month.value === thisMonth ? today.value : `${month.value}-01`)
      : (year.value === today.value.slice(0, 4) ? today.value : `${year.value}-01-01`)
  setQuery({ view: next === 'month' ? undefined : next, date: anchor === today.value ? undefined : anchor, month: undefined, year: undefined })
}
function step(by: 1 | -1): void {
  if (view.value === 'year') setQuery({ year: String(Number(year.value) + by) })
  else if (view.value === 'month') setQuery({ month: shiftMonth(month.value, by) })
  else setQuery({ date: addDays(date.value, by) })
}
const goToday = () => setQuery({ year: undefined, month: undefined, date: undefined })
const heading = computed(() => {
  if (view.value === 'year') return year.value
  if (view.value === 'day') return format.date(date.value, 'long')
  return new Intl.DateTimeFormat(localeTag(locale.value), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month.value}-01T00:00:00Z`))
})
const current = computed(() => (view.value === 'day' ? day : range))

const room = ref<OccupancyRoomDto | null>(null)
watch([date, view, hotelId], () => { room.value = null })

function download(): void {
  if (!day.data.value || !hotel.value) return
  const csv = csvOf(day.data.value, {
    header: [t('occupancy.csv.floor'), t('rooms.room'), t('occupancy.stateLabel'), t('occupancy.csv.taken'), t('occupancy.csv.places'), t('bookings.column'), t('bookings.bookedBy'), t('occupancy.csv.pilgrim'), t('bookings.status')],
    state: state => t(`occupancy.state.${state}`),
    status: status => t(`status.guest.${status}`),
    individual: t('bookings.individual'),
    agency: t('bookings.agency'),
  })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  link.download = `occupancy-${hotel.value.code.replace(/[^\w-]/g, '')}-${date.value}.csv`
  document.body.append(link)
  link.click()
  link.remove()
  // Some browsers start the download after this turn: the file is let go a moment later.
  setTimeout(() => URL.revokeObjectURL(link.href), 0)
}
</script>

<template>
  <HotelFrame :title="t('nav.occupancy')">
    <EmptyState v-if="ready && !allowed" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <template v-else>
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex gap-1" role="group" :aria-label="t('occupancy.view')">
          <UButton v-for="v in VIEWS" :key="v" size="sm" :color="view === v ? 'primary' : 'neutral'" :variant="view === v ? 'soft' : 'ghost'" :aria-pressed="view === v" @click="show(v)">{{ t(`occupancy.views.${v}`) }}</UButton>
        </div>
        <UButton color="neutral" variant="outline" @click="goToday">{{ t('calendar.today') }}</UButton>
        <UButton color="neutral" variant="ghost" icon="i-lucide-chevron-left" :aria-label="t('calendar.previous')" :ui="{ leadingIcon: 'rtl:-scale-x-100' }" @click="step(-1)" />
        <span class="min-w-40 text-center font-medium tabular" aria-live="polite">{{ heading }}</span>
        <UButton color="neutral" variant="ghost" icon="i-lucide-chevron-right" :aria-label="t('calendar.next')" :ui="{ leadingIcon: 'rtl:-scale-x-100' }" @click="step(1)" />
        <UButton v-if="view === 'day' && day.data.value" color="neutral" variant="outline" icon="i-lucide-download" class="ms-auto" @click="download">{{ t('occupancy.download') }}</UButton>
      </div>

      <ErrorState v-if="current.error.value" :error="current.error.value" @retry="current.refetch()" />
      <USkeleton v-else-if="!current.data.value" class="h-96" />
      <div v-else-if="view === 'year'" class="flex flex-col gap-4" :class="{ 'opacity-60': range.isPlaceholderData.value }">
        <p class="flex flex-wrap gap-3 text-caption text-(--fg-muted)">
          <span class="flex items-center gap-1"><span class="size-3 rounded-sm bg-(--success-soft)" aria-hidden="true" />{{ t('occupancy.tone.low') }}</span>
          <span class="flex items-center gap-1"><span class="size-3 rounded-sm bg-(--warning-soft)" aria-hidden="true" />{{ t('occupancy.tone.mid') }}</span>
          <span class="flex items-center gap-1"><span class="size-3 rounded-sm bg-(--danger-soft)" aria-hidden="true" />{{ t('occupancy.tone.high') }}</span>
          <span v-for="period in markedPeriods" :key="period.id" class="flex items-center gap-1"><span class="h-0.5 w-3 bg-(--season)" aria-hidden="true" /><bdi>{{ period.name }}</bdi> · <NightsRange :from="period.startDate" :to="period.endDate" :count="false" /></span>
        </p>
        <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <OccupancyMonth v-for="m in months" :key="m" :month="m" :days="days" :today="today" :seasons="seasons" compact @open="openDay" />
        </div>
      </div>
      <div v-else-if="view === 'month'" :class="{ 'opacity-60': range.isPlaceholderData.value }">
        <OccupancyMonth :month="month" :days="days" :today="today" :seasons="seasons" @open="openDay" />
      </div>
      <OccupancyDay v-else-if="day.data.value" :day="day.data.value" :class="{ 'opacity-60': day.isPlaceholderData.value }" @open-room="value => room = value" />
      <OccupancyRoomDrawer v-if="hotel" :hotel="hotel" :date="date" :room="room" @close="room = null" />
    </template>
  </HotelFrame>
</template>
