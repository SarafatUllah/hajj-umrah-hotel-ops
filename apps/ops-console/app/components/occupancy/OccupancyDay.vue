<script setup lang="ts">
import { OCCUPANCIES } from '@hajj/contracts/constants/booking'
import { ROOM_NIGHT_STATES, type OccupancyDayViewDto, type OccupancyRoomDto, type RoomNightState } from '@hajj/contracts/types/occupancy'
import { bookerName, type DayFilters, INDIVIDUAL, roomMatches } from '../../utils/occupancy'

/**
 * One day of the occupancy calendar (v7 §14): the day's summary (rooms by state, places, who sleeps here by booker,
 * arrivals and departures, details still missing), filters, then each floor as a row of room tiles — the places taken
 * of the room's, who holds it and on which side. A tile opens the room's bookings and pilgrims.
 */
const props = defineProps<{ day: OccupancyDayViewDto }>()
const emit = defineEmits<{ openRoom: [OccupancyRoomDto] }>()
const { t } = useI18n()
const ALL = 'ALL'

const filters = ref({ agency: ALL, occupancy: ALL, state: ALL, roomType: ALL })
const active = computed<DayFilters>(() => Object.fromEntries(Object.entries(filters.value).filter(([, value]) => value !== ALL)))
const floors = computed(() => props.day.floors.map(floor => ({ ...floor, rooms: floor.rooms.filter(room => roomMatches(room, active.value)) })).filter(floor => floor.rooms.length))
const filtered = computed(() => Object.keys(active.value).length > 0)
const clearFilters = () => { filters.value = { agency: ALL, occupancy: ALL, state: ALL, roomType: ALL } }

// The agencies and room types seen on any day stay named: a filter kept while stepping to a day without them still
// reads as itself (and finds nothing) instead of an empty field.
const knownAgencies = ref(new Map<string, string>())
const knownTypes = ref(new Map<string, string>())
watch(() => props.day, (day) => {
  knownAgencies.value = new Map([...knownAgencies.value, ...day.summary.byBooker.flatMap(b => (b.agencyId ? [[b.agencyId, b.name ?? t('bookings.agency')] as const] : []))])
  knownTypes.value = new Map([...knownTypes.value, ...day.floors.flatMap(f => f.rooms.map(r => [r.roomType.id, r.roomType.name] as const))])
}, { immediate: true })
const agencyItems = computed(() => [
  { value: ALL, label: t('bookings.allAgencies') },
  ...[...knownAgencies.value].map(([value, label]) => ({ value, label })),
  { value: INDIVIDUAL, label: t('occupancy.individuals') },
])
const occupancyItems = computed(() => [{ value: ALL, label: t('occupancy.allSides') }, ...OCCUPANCIES.map(value => ({ value, label: t(`booking.occupancy.${value}`) }))])
const stateItems = computed(() => [{ value: ALL, label: t('occupancy.allStates') }, ...ROOM_NIGHT_STATES.map(value => ({ value, label: t(`occupancy.state.${value}`) }))])
const typeItems = computed(() => [{ value: ALL, label: t('rooms.allTypes') }, ...[...knownTypes.value].map(([value, label]) => ({ value, label }))])

const STATE_CLASS: Record<RoomNightState, string> = {
  FULL: 'bg-(--primary) text-inverted border-transparent',
  PARTIAL: 'bg-(--primary-soft) border-(--primary)',
  HELD: 'bg-(--info-soft) border-dashed border-(--info)',
  EMPTY: 'bg-(--surface-1) border-(--border)',
  BLOCKED: 'bg-[repeating-linear-gradient(135deg,var(--neutral-soft)_0_6px,transparent_6px_10px)] border-(--border) text-(--fg-muted)',
}
/** Who holds the room, in a word: the booker (and the side, in a group), "held", empty or out of service. */
function holderOf(room: OccupancyRoomDto): string {
  const claim = room.claims[0]
  if (!claim) return room.state === 'BLOCKED' ? t(`status.inventory.${room.inventoryStatus}`) : t('occupancy.state.EMPTY')
  if (room.claims.length > 1) return t('occupancy.severalBookings', { count: room.claims.length }, room.claims.length)
  const who = bookerName(claim.booker, { individual: t('bookings.individual'), agency: t('bookings.agency') })
  return `${who} · ${t(`booking.occupancy.${claim.occupancy}`)}`
}
const extraBedsOf = (room: OccupancyRoomDto) => room.claims.reduce((sum, c) => sum + c.extraBeds, 0)
const tileLabel = (room: OccupancyRoomDto) => t('occupancy.tileLabel', { room: room.roomNumber, state: t(`occupancy.state.${room.state}`), taken: room.booked + room.held, places: room.capacity, holder: holderOf(room) })
const summary = computed(() => props.day.summary)
</script>

<template>
  <div class="flex flex-col gap-5">
    <section class="surface-panel grid gap-4 p-5 md:grid-cols-3" :aria-label="t('occupancy.summary')">
      <div>
        <h3 class="text-caption text-(--fg-muted)">{{ t('occupancy.rooms', { count: summary.rooms.total }) }}</h3>
        <p class="tabular">
          {{ t('occupancy.state.FULL') }} {{ summary.rooms.full }} · {{ t('occupancy.state.PARTIAL') }} {{ summary.rooms.partial }} · {{ t('occupancy.state.HELD') }} {{ summary.rooms.held }} ·
          {{ t('occupancy.state.EMPTY') }} {{ summary.rooms.empty }} · {{ t('occupancy.state.BLOCKED') }} {{ summary.rooms.blocked }}
        </p>
      </div>
      <div>
        <h3 class="text-caption text-(--fg-muted)">{{ t('occupancy.places', { count: summary.seats.total }) }}</h3>
        <p class="tabular">{{ t('occupancy.pilgrimsSeated') }} {{ summary.seats.pilgrims }} · {{ t('occupancy.state.HELD') }} {{ summary.seats.held }} · {{ t('occupancy.state.EMPTY') }} {{ summary.seats.empty }} · {{ summary.occupancyPercent }}%</p>
      </div>
      <div>
        <h3 class="text-caption text-(--fg-muted)">{{ t('occupancy.desk') }}</h3>
        <p class="tabular">{{ t('occupancy.arrivals') }} {{ summary.arrivals }} · {{ t('occupancy.departures') }} {{ summary.departures }} · {{ t('occupancy.detailsPending') }} {{ summary.detailsPending }}</p>
      </div>
      <ul v-if="summary.byBooker.length" class="flex flex-wrap gap-x-4 gap-y-1 text-small md:col-span-3">
        <li v-for="booker in summary.byBooker" :key="booker.agencyId ?? INDIVIDUAL">
          <bdi class="font-medium">{{ booker.name ?? t('occupancy.individuals') }}</bdi>: {{ t('occupancy.bookerShare', { pilgrims: booker.pilgrims, rooms: booker.rooms }) }}
        </li>
      </ul>
    </section>

    <div class="flex flex-wrap items-center gap-2">
      <USelect v-model="filters.agency" :items="agencyItems" :aria-label="t('bookings.agency')" class="w-52" />
      <USelect v-model="filters.occupancy" :items="occupancyItems" :aria-label="t('occupancy.side')" class="w-40" />
      <USelect v-model="filters.state" :items="stateItems" :aria-label="t('occupancy.stateLabel')" class="w-40" />
      <USelect v-model="filters.roomType" :items="typeItems" :aria-label="t('rooms.type')" class="w-44" />
      <UButton v-if="filtered" color="neutral" variant="ghost" @click="clearFilters">{{ t('common.clearFilters') }}</UButton>
    </div>

    <EmptyState v-if="!floors.length" :title="filtered ? t('rooms.noMatch') : t('rooms.none')" icon="i-lucide-layout-grid">
      <UButton v-if="filtered" color="neutral" variant="outline" @click="clearFilters">{{ t('common.clearFilters') }}</UButton>
    </EmptyState>
    <section v-for="floor in floors" :key="floor.id" class="flex flex-col gap-2" :aria-label="floor.label">
      <h3 class="text-subsection"><bdi>{{ floor.label }}</bdi></h3>
      <ul class="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
        <li v-for="room in floor.rooms" :key="room.roomId">
          <button
            type="button"
            class="flex w-full flex-col items-start gap-0.5 rounded-md border p-2 text-start hover:brightness-95 focus-visible:outline-2 focus-visible:outline-(--focus-ring)"
            :class="STATE_CLASS[room.state]"
            :aria-label="tileLabel(room)"
            @click="emit('openRoom', room)"
          >
            <span class="flex w-full items-baseline justify-between gap-2">
              <span class="font-semibold tabular" dir="ltr">{{ room.roomNumber }}</span>
              <span class="text-small tabular" dir="ltr">{{ room.booked + room.held }}/{{ room.capacity }}<template v-if="extraBedsOf(room)">+{{ extraBedsOf(room) }}</template></span>
            </span>
            <span class="w-full truncate text-caption"><bdi>{{ holderOf(room) }}</bdi></span>
          </button>
        </li>
      </ul>
    </section>
    <p class="flex flex-wrap gap-3 text-caption text-(--fg-muted)">
      <span v-for="state in ROOM_NIGHT_STATES" :key="state" class="flex items-center gap-1"><span class="size-3 rounded-sm border" :class="STATE_CLASS[state]" aria-hidden="true" />{{ t(`occupancy.state.${state}`) }}</span>
      <span>{{ t('occupancy.legendSeats') }}</span>
    </p>
  </div>
</template>
