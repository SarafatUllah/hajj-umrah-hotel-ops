<script setup lang="ts">
import { useQueries } from '@tanstack/vue-query'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { CapacityPeriodDto, DailySummary, DailySummaryDto, HotelAveragesDto, OrganizationAveragesDto } from '@hajj/contracts/types/inventory'
import { addDays } from '@hajj/contracts/utils/dates'

/**
 * The Overview (§21.2): a truthful status of inventory for the scope — all hotels, or one (`?hotel=`). Tonight's
 * figures, the capacity outlook (30 or 90 nights), what needs attention, the seasons, and per hotel. Every figure is
 * the server's (each hotel's own today); sums are of the hotels' numbers, never averages of averages.
 */
definePageMeta({ middleware: 'auth', scope: 'portfolio' })
const { t } = useI18n()
const api = useApi()
const access = useAccess()
const format = useFormat()
const { hotels, current } = useHotelScope()
useSeoMeta({ title: () => t('nav.overview') })
if (!access.value.can('room.view')) await navigateTo('/hotels', { replace: true })

const scope = computed<HotelSummary[]>(() => (current.value ? [current.value] : hotels.items.value.filter(h => h.status === 'ACTIVE')))
const RANGES = [30, 90] as const
const range = ref<typeof RANGES[number]>(30)
const summaryOf = (hotel: HotelSummary, from: string, to: string) => ({
  queryKey: ['daily-summary', hotel.id, from, to],
  queryFn: () => api<DailySummaryDto>(`/hotels/${hotel.id}/inventory/daily-summary`, { query: { from, to } }),
})
const tonight = useQueries({ queries: computed(() => scope.value.map(h => summaryOf(h, h.today, h.today))) })
const outlook = useQueries({ queries: computed(() => scope.value.map(h => summaryOf(h, h.today, addDays(h.today, range.value - 1)))) })
const seasons = useQueries({
  queries: computed(() => scope.value.map(h => ({
    queryKey: ['seasons', h.id, false],
    queryFn: () => api<CapacityPeriodDto[]>(`/hotels/${h.id}/capacity-periods`, { query: { includePast: 'false' } }),
  }))),
})
const oneHotel = computed(() => scope.value.length === 1 ? scope.value[0]! : null)
const hotelAverages = useApiQuery(() => ['hotel-averages', oneHotel.value?.id ?? ''], () => api<HotelAveragesDto>(`/hotels/${oneHotel.value!.id}/capacity/averages`), { enabled: computed(() => !!oneHotel.value) })
const orgAverages = useApiQuery(['capacity-averages'], () => api<OrganizationAveragesDto>('/capacity/averages'), { enabled: computed(() => !oneHotel.value) })

const nights = computed(() => tonight.value.map(q => q.data?.days[0]).filter((day): day is DailySummary => !!day))
const loadingTonight = computed(() => tonight.value.some(q => q.isPending))
const firstError = (queries: Array<{ error: unknown }>) => queries.find(q => q.error)?.error ?? null
const tonightError = computed(() => firstError(tonight.value) ?? (oneHotel.value ? hotelAverages.error.value : orgAverages.error.value))
const outlookError = computed(() => firstError(outlook.value))
const seasonsError = computed(() => firstError(seasons.value))
const sum = (key: 'roomsInInventory' | 'sellableRooms' | 'effectiveSellableCapacity' | 'outOfService' | 'maintenance') => nights.value.reduce((total, day) => total + day[key], 0)
const average = computed(() => (oneHotel.value ? hotelAverages.data.value : orgAverages.data.value))
const metrics = computed(() => [
  { label: t('overview.roomsInInventory'), value: sum('roomsInInventory') },
  { label: t('overview.sellable'), value: t('overview.ofRooms', { sellable: sum('sellableRooms'), total: sum('roomsInInventory') }) },
  { label: t('overview.capacity'), value: sum('effectiveSellableCapacity'), hint: t('overview.capacityHint') },
  { label: t('overview.average'), value: average.value?.dateEffective.display ?? '—', hint: t('overview.normal', { value: average.value?.base.display ?? '—' }) },
])
/** Each night's capacity across the scope; hotels in other time zones still line up by their own nights. */
const outlookDays = computed(() => {
  const byNight = new Map<number, { date: string, value: number }>()
  for (const query of outlook.value) {
    query.data?.days.forEach((day, index) => {
      const entry = byNight.get(index) ?? { date: day.date, value: 0 }
      byNight.set(index, { date: entry.date, value: entry.value + day.effectiveSellableCapacity })
    })
  }
  return [...byNight.entries()].sort(([a], [b]) => a - b).map(([, day]) => day)
})
const seasonRows = computed(() => seasons.value.flatMap((query, index) => (query.data ?? []).map(season => ({ season, hotel: scope.value[index]! })))
  .sort((a, b) => a.season.startDate.localeCompare(b.season.startDate)))
/** The same season at several hotels (same name and nights) reads once: its hotels and rooms summed. */
const seasonGroups = computed(() => {
  const groups = new Map<string, { season: CapacityPeriodDto, hotels: string[], rooms: number }>()
  for (const { season, hotel } of seasonRows.value) {
    const key = `${season.name}|${season.startDate}|${season.endDate}`
    const group = groups.get(key) ?? { season, hotels: [], rooms: 0 }
    groups.set(key, { ...group, hotels: [...group.hotels, hotel.name], rooms: group.rooms + season.overrideCount })
  }
  return [...groups.values()]
})
const attention = computed(() => [
  ...(sum('outOfService') ? [{ key: 'oos', text: t('overview.outOfService', sum('outOfService')) }] : []),
  ...(sum('maintenance') ? [{ key: 'maint', text: t('overview.maintenance', sum('maintenance')) }] : []),
  ...seasonRows.value.filter(r => r.season.phase === 'FUTURE' && r.season.overrideCount === 0).map(r => ({ key: r.season.id, text: t('overview.seasonEmpty', { season: r.season.name, hotel: r.hotel.name }) })),
])
const perHotel = computed(() => scope.value.map((hotel, index) => ({ hotel, night: tonight.value[index]?.data?.days[0], average: orgAverages.data.value?.perHotel.find(p => p.hotelId === hotel.id) })))
const asOf = computed(() => (oneHotel.value ? format.date(oneHotel.value.today, 'long') : t('overview.eachToday')))
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader :title="t('nav.overview')" :description="oneHotel ? oneHotel.name : t('overview.allHotels')">
      <template #actions><span class="text-small text-(--fg-muted)">{{ t('overview.tonightAsOf', { date: asOf }) }}</span></template>
    </PageHeader>
    <ErrorState v-if="hotels.error.value" :error="hotels.error.value" @retry="hotels.refetch()" />
    <EmptyState v-else-if="hotels.data.value && !scope.length" :title="t('overview.noHotels')" icon="i-lucide-building-2" />
    <template v-else>
      <ErrorState v-if="tonightError" :error="tonightError" @retry="() => { tonight.forEach(q => q.refetch()); void (oneHotel ? hotelAverages.refetch() : orgAverages.refetch()) }" />
      <USkeleton v-else-if="loadingTonight || !hotels.data.value" class="h-24" />
      <MetricStrip v-else :items="metrics" />

      <section aria-labelledby="outlook-heading" class="surface-panel flex flex-col gap-3 p-5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 id="outlook-heading" class="text-section">{{ t('overview.outlook', { nights: range }) }}</h2>
          <div class="flex gap-1" role="group" :aria-label="t('overview.range')">
            <UButton v-for="option in RANGES" :key="option" size="sm" :color="range === option ? 'primary' : 'neutral'" :variant="range === option ? 'soft' : 'ghost'" :aria-pressed="range === option" @click="range = option">{{ t('overview.nights', { count: option }, option) }}</UButton>
          </div>
        </div>
        <ErrorState v-if="outlookError" :error="outlookError" @retry="outlook.forEach(q => q.refetch())" />
        <USkeleton v-else-if="outlook.some(q => q.isPending)" class="h-32" />
        <OutlookChart v-else :days="outlookDays" />
      </section>

      <div class="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="attention-heading" class="surface-panel flex flex-col gap-3 p-5">
          <h2 id="attention-heading" class="text-section">{{ t('overview.attention') }}</h2>
          <ErrorState v-if="seasonsError" :error="seasonsError" @retry="seasons.forEach(q => q.refetch())" />
          <p v-else-if="!attention.length" class="text-(--fg-muted)">{{ t('overview.nothingNeeded') }}</p>
          <ul v-else class="flex list-disc flex-col gap-1 ps-5"><li v-for="item in attention" :key="item.key">{{ item.text }}</li></ul>
        </section>
        <section aria-labelledby="seasons-heading" class="surface-panel flex flex-col gap-3 p-5">
          <h2 id="seasons-heading" class="text-section">{{ t('hotel.seasons') }}</h2>
          <ErrorState v-if="seasonsError" :error="seasonsError" @retry="seasons.forEach(q => q.refetch())" />
          <USkeleton v-else-if="seasons.some(q => q.isPending)" class="h-16" />
          <p v-else-if="!seasonGroups.length" class="text-(--fg-muted)">{{ t('hotel.noSeasons') }}</p>
          <ul v-else class="flex flex-col gap-2">
            <li v-for="group in seasonGroups" :key="group.season.id" class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span class="font-medium"><bdi>{{ group.season.name }}</bdi></span>
              <StatusBadge domain="season" :value="group.season.phase" />
              <NightsRange :from="group.season.startDate" :to="group.season.endDate" :count="false" />
              <UTooltip v-if="!oneHotel" :text="group.hotels.join(', ')">
                <span class="text-small text-(--fg-muted)">{{ t('overview.hotelsCount', group.hotels.length) }}</span>
              </UTooltip>
              <span class="text-small text-(--fg-muted)">{{ t('common.rooms', group.rooms) }}</span>
            </li>
          </ul>
        </section>
      </div>

      <section v-if="!oneHotel" aria-labelledby="hotels-heading" class="flex flex-col gap-3">
        <h2 id="hotels-heading" class="text-section">{{ t('nav.hotels') }}</h2>
        <div class="surface-panel overflow-x-auto">
          <table class="w-full">
            <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
              <tr>
                <th scope="col" class="px-4 py-2 text-start">{{ t('hotels.column.hotel') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('hotels.column.rooms') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('overview.sellableColumn') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('hotels.column.capacity') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('hotels.column.average') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('overview.unavailable') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-(--border)">
              <tr v-for="row in perHotel" :key="row.hotel.id">
                <td class="px-4 py-3">
                  <NuxtLink :to="{ path: '/overview', query: { hotel: row.hotel.code } }" class="flex items-center gap-2 hover:underline"><HotelMarker :hotel="row.hotel" size="sm" /><bdi>{{ row.hotel.name }}</bdi></NuxtLink>
                </td>
                <td class="px-4 py-3 text-end tabular">{{ row.night?.roomsInInventory ?? '—' }}</td>
                <td class="px-4 py-3 text-end tabular">{{ row.night?.sellableRooms ?? '—' }}</td>
                <td class="px-4 py-3 text-end tabular">{{ row.night?.effectiveSellableCapacity ?? '—' }}</td>
                <td class="px-4 py-3 text-end tabular">{{ row.average?.dateEffective.display ?? '—' }}</td>
                <td class="px-4 py-3 text-end tabular">{{ row.night ? row.night.roomsInInventory - row.night.sellableRooms : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
