<script setup lang="ts">
import { keepPreviousData, useInfiniteQuery } from '@tanstack/vue-query'
import type { ResolvedSettings } from '@hajj/contracts/business-rules/hotelSettings'
import { CALENDAR_FILTER_STATUSES, type CalendarFilterStatus } from '@hajj/contracts/constants/inventory'
import type { CalendarRoomDto, CapacityPeriodDto, DailySummaryDto, RoomCalendarDto } from '@hajj/contracts/types/inventory'
import { addDays, isValidIsoDate } from '@hajj/contracts/utils/dates'
import { calendarRange, COLUMN_WIDTH, type Zoom, ZOOMS } from '../../../utils/calendar'
import type { BlockRoom } from '../../../utils/inventory'

/**
 * The room calendar (§31): every room, every night — what it can hold and whether it can be sold — from the API's
 * runs of nights (never one request per night). The view lives in the URL (range, zoom, filters, the open cell).
 * Rooms load a hundred at a time. Block from a night, or block the rooms ticked in the room column (`room.block`).
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const { queryOf, setQuery, searchOf } = useUrlQuery()
const api = useApi()
const format = useFormat()
const notify = useNotify()
const hotelRefresh = useHotelRefresh()
const access = useAccess()
const { hotel, hotelId, ready, isInactive } = useCurrentHotel()
const floors = useFloors(hotelId)
const types = useRoomTypes()
const PAGE_SIZE = 100
const ALL = 'ALL'

const settings = useApiQuery(() => ['hotel-settings', hotelId.value], () => api<ResolvedSettings>(`/hotels/${hotelId.value}/settings`), { enabled: ready })
const askedZoom = computed(() => ZOOMS.find(z => z === Number(queryOf('nights'))))
const zoom = computed<Zoom>(() => {
  if (askedZoom.value) return askedZoom.value
  const preferred = settings.data.value?.['calendar.defaultRangeDays'] ?? 31
  return ZOOMS.reduce((best, z) => (Math.abs(z - preferred) < Math.abs(best - preferred) ? z : best), 31 as Zoom)
})
// Without a zoom in the link, the hotel's default range decides it: wait for it rather than load twice.
const zoomKnown = computed(() => !!askedZoom.value || !settings.isPending.value)
const range = computed(() => (zoomKnown.value ? calendarRange({ today: hotel.value?.today ?? '', from: queryOf('from'), nights: zoom.value }) : null))
function moveRange(direction: 1 | -1): void {
  if (range.value) setQuery({ from: addDays(range.value.from, direction * range.value.nights), room: undefined, night: undefined })
}
const goToday = () => setQuery({ from: undefined })

const floor = computed({ get: () => queryOf('floor') ?? ALL, set: (value: string) => setQuery({ floor: value === ALL ? undefined : value }) })
const type = computed({ get: () => queryOf('type') ?? ALL, set: (value: string) => setQuery({ type: value === ALL ? undefined : value }) })
// Only the statuses the calendar knows are read from the URL (a mistyped link must not fail the page).
const isFilterStatus = (value: string): value is CalendarFilterStatus => (CALENDAR_FILTER_STATUSES as readonly string[]).includes(value)
const statuses = computed({ get: () => (queryOf('status') ?? '').split(',').filter(isFilterStatus), set: (value: CalendarFilterStatus[]) => setQuery({ status: value.join(',') || undefined }) })
const match = computed({ get: () => (queryOf('match') === 'all' ? 'all' : 'any'), set: (value: string) => setQuery({ match: value === 'any' ? undefined : value }) })
const includeOut = computed({ get: () => queryOf('all') === '1', set: (value: boolean) => setQuery({ all: value ? '1' : undefined }) })
const search = searchOf('q')
const filtered = computed(() => floor.value !== ALL || type.value !== ALL || statuses.value.length > 0 || !!queryOf('q') || includeOut.value)
const clearFilters = () => setQuery({ floor: undefined, type: undefined, status: undefined, match: undefined, q: undefined, all: undefined })

const filters = computed(() => ({
  floorId: floor.value === ALL ? undefined : floor.value,
  roomTypeId: type.value === ALL ? undefined : type.value,
  q: queryOf('q'),
  status: statuses.value.join(',') || undefined,
  statusMatch: statuses.value.length ? match.value : undefined,
  includeOutOfInventory: includeOut.value ? 'true' : undefined,
}))
const filterQuery = computed(() => ({ from: range.value?.from, to: range.value?.to, ...filters.value }))
const calendar = useInfiniteQuery({
  queryKey: computed(() => ['calendar', hotelId.value, filterQuery.value]),
  queryFn: ({ pageParam }) => api<RoomCalendarDto>(`/hotels/${hotelId.value}/room-calendar`, { query: { ...filterQuery.value, page: pageParam, pageSize: PAGE_SIZE } }),
  initialPageParam: 1,
  getNextPageParam: last => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  enabled: computed(() => ready.value && !!range.value),
  placeholderData: keepPreviousData,
})
const rooms = computed<CalendarRoomDto[]>(() => calendar.data.value?.pages.flatMap(p => p.rooms) ?? [])
const refs = computed(() => {
  const pages = calendar.data.value?.pages ?? []
  return { periods: Object.assign({}, ...pages.map(p => p.refs.periods)), blocks: Object.assign({}, ...pages.map(p => p.refs.blocks)), bookings: Object.assign({}, ...pages.map(p => p.refs.bookings)) }
})
const total = computed(() => calendar.data.value?.pages[0]?.total ?? 0)
const summary = useApiQuery(
  () => ['daily-summary', hotelId.value, range.value?.from, range.value?.to, floor.value, type.value],
  () => api<DailySummaryDto>(`/hotels/${hotelId.value}/inventory/daily-summary`, { query: { from: filterQuery.value.from, to: filterQuery.value.to, floorId: filterQuery.value.floorId, roomTypeId: filterQuery.value.roomTypeId } }),
  { enabled: computed(() => ready.value && !!range.value), placeholderData: keepPreviousData },
)
const seasons = useApiQuery(() => ['seasons', hotelId.value, true], () => api<CapacityPeriodDto[]>(`/hotels/${hotelId.value}/capacity-periods`, { query: { includePast: 'true' } }), { enabled: ready })
const tooMany = computed(() => calendar.error.value && toApiError(calendar.error.value).code === 'TOO_MANY_ROOMS')

const canBlock = computed(() => ready.value && access.value.canInHotel('room.block', hotelId.value) && !isInactive.value)
const selected = ref<Set<string>>(new Set())
// The ticked rooms are kept across ranges, and cleared when the filters change.
watch(filters, () => { selected.value = new Set() })
const toggle = (roomId: string, on: boolean) => {
  const next = new Set(selected.value)
  if (on) next.add(roomId)
  else next.delete(roomId)
  selected.value = next
}

// The cell drawer follows the URL (`room`, `night`), so it can be shared.
const openRoom = computed(() => rooms.value.find(r => r.roomId === queryOf('room')) ?? null)
const openNight = computed(() => {
  const night = queryOf('night')
  return night && isValidIsoDate(night) ? night : null
})
function open(index: number, night: string): void {
  // While another range is loading, what is shown is the previous one: a click would name the wrong night.
  if (!calendar.isPlaceholderData.value) setQuery({ room: rooms.value[index]?.roomId, night })
}
const close = () => setQuery({ room: undefined, night: undefined })
// A shared link to a room further down the list loads on until it is there; one the filters no longer match closes.
watch([() => queryOf('room'), openRoom, () => calendar.isFetching.value], ([roomId, found, fetching]) => {
  if (!roomId || found || fetching || !calendar.data.value || calendar.isFetchNextPageError.value) return
  if (calendar.hasNextPage.value) void calendar.fetchNextPage()
  else close()
})
const retryCalendar = () => (calendar.isFetchNextPageError.value ? calendar.fetchNextPage() : calendar.refetch())

const blocking = ref<{ rooms: BlockRoom[], startDate?: string } | null>(null)
/** A room's Haji capacity on a night (else its first known one), for the block drawer's "up to". */
const haji = (room: CalendarRoomDto, night?: string) => (room.segments.find(s => night && s.from <= night && night <= s.to && s.sellableCapacity !== null)
  ?? room.segments.find(s => s.sellableCapacity !== null))?.sellableCapacity ?? null
function blockFrom(room: CalendarRoomDto, night: string): void {
  close()
  blocking.value = { rooms: [{ id: room.roomId, roomNumber: room.roomNumber, haji: haji(room, night) }], startDate: night }
}
function blockSelected(): void {
  blocking.value = { rooms: rooms.value.filter(r => selected.value.has(r.roomId)).map(r => ({ id: r.roomId, roomNumber: r.roomNumber, haji: haji(r) })) }
}
async function blocked(count: number): Promise<void> {
  notify.done(t('blocks.saved', { count }, count))
  selected.value = new Set()
  await hotelRefresh(hotelId.value)
}
const floorItems = computed(() => [{ value: ALL, label: t('rooms.allFloors') }, ...floors.items.value])
const typeItems = computed(() => [{ value: ALL, label: t('rooms.allTypes') }, ...types.items.value])
const statusItems = computed(() => CALENDAR_FILTER_STATUSES.map(value => ({ value, label: t(`status.inventory.${value}`) })))
const matchItems = computed(() => [{ value: 'any', label: t('calendar.anyNight') }, { value: 'all', label: t('calendar.everyNight') }])
</script>

<template>
  <HotelFrame :title="t('nav.calendar')">
    <template #actions>
      <UButton v-if="canBlock" icon="i-lucide-lock" :disabled="!selected.size" @click="blockSelected">{{ selected.size ? t('blocks.blockCount', { count: selected.size }, selected.size) : t('blocks.title') }}</UButton>
    </template>
    <div class="flex flex-wrap items-center gap-2">
      <UButton color="neutral" variant="outline" @click="goToday">{{ t('calendar.today') }}</UButton>
      <UButton color="neutral" variant="ghost" icon="i-lucide-chevron-left" :aria-label="t('calendar.previous')" :ui="{ leadingIcon: 'rtl:-scale-x-100' }" @click="moveRange(-1)" />
      <span class="min-w-48 text-center font-medium tabular">{{ range ? `${format.date(range.from, 'short')} – ${format.date(range.to)}` : '' }}</span>
      <UButton color="neutral" variant="ghost" icon="i-lucide-chevron-right" :aria-label="t('calendar.next')" :ui="{ leadingIcon: 'rtl:-scale-x-100' }" @click="moveRange(1)" />
      <div class="flex gap-1" role="group" :aria-label="t('calendar.zoom')">
        <UButton v-for="z in ZOOMS" :key="z" size="sm" :color="zoom === z ? 'primary' : 'neutral'" :variant="zoom === z ? 'soft' : 'ghost'" :aria-pressed="zoom === z" @click="setQuery({ nights: String(z) })">{{ t('overview.nights', { count: z }, z) }}</UButton>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <USelect v-model="floor" :items="floorItems" :aria-label="t('rooms.floor')" class="w-36" />
      <USelect v-model="type" :items="typeItems" :aria-label="t('rooms.type')" class="w-40" />
      <UInput v-model="search" :placeholder="t('rooms.search')" :aria-label="t('rooms.search')" dir="ltr" class="w-32" />
      <USelectMenu v-model="statuses" :items="statusItems" value-key="value" multiple :placeholder="t('calendar.status')" :aria-label="t('calendar.status')" class="w-52" />
      <USelect v-if="statuses.length" v-model="match" :items="matchItems" :aria-label="t('calendar.match')" class="w-36" />
      <USwitch v-model="includeOut" :label="t('calendar.includeOut')" />
      <UButton v-if="filtered" color="neutral" variant="ghost" @click="clearFilters">{{ t('common.clearFilters') }}</UButton>
    </div>
    <p v-if="floor !== ALL || type !== ALL" class="text-small text-(--fg-muted)">{{ t('calendar.summaryScope') }}</p>

    <UAlert v-if="tooMany" color="warning" variant="soft" icon="i-lucide-filter" :title="t('calendar.tooMany')" />
    <ErrorState v-else-if="calendar.error.value && !rooms.length" :error="calendar.error.value" @retry="retryCalendar" />
    <USkeleton v-else-if="calendar.isPending.value" class="h-96" />
    <EmptyState v-else-if="!rooms.length" :title="filtered ? t('rooms.noMatch') : t('rooms.none')" icon="i-lucide-calendar-days">
      <UButton v-if="filtered" color="neutral" variant="outline" @click="clearFilters">{{ t('common.clearFilters') }}</UButton>
    </EmptyState>
    <template v-else-if="hotel && range">
      <div :class="{ 'opacity-60': calendar.isPlaceholderData.value }">
        <CalendarGrid
          :rooms="rooms"
          :total="total"
          :refs="refs"
          :from="range.from"
          :nights="range.nights"
          :column-width="COLUMN_WIDTH[zoom]"
          :today="hotel.today"
          :seasons="seasons.data.value ?? []"
          :summary="summary.data.value?.days ?? []"
          :selectable="canBlock"
          :selected="selected"
          @open="open"
          @toggle="toggle"
        />
      </div>
      <ErrorState v-if="calendar.error.value" :error="calendar.error.value" @retry="retryCalendar" />
      <div class="flex flex-wrap items-center justify-between gap-2 text-small text-(--fg-muted)">
        <span>{{ t('calendar.shown', { shown: rooms.length, total }) }}</span>
        <UButton v-if="calendar.hasNextPage.value" color="neutral" variant="outline" :loading="calendar.isFetchingNextPage.value" @click="calendar.fetchNextPage()">{{ t('calendar.more') }}</UButton>
      </div>
      <CalendarCellDrawer :hotel="hotel" :room="openRoom" :night="openNight" :refs="refs" :can-block="canBlock" @close="close" @block="blockFrom" />
      <BlockDrawer :open="!!blocking" :hotel="hotel" :rooms="blocking?.rooms" :start-date="blocking?.startDate" @update:open="value => { if (!value) blocking = null }" @saved="saved => blocked(saved.length)" />
    </template>
  </HotelFrame>
</template>
