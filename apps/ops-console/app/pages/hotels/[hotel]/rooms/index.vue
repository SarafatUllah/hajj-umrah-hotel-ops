<script setup lang="ts">
import { keepPreviousData } from '@tanstack/vue-query'
import type { RoomListItem, RoomListPage } from '@hajj/contracts/types/rooms'
import type { BlockRoom } from '../../../../utils/inventory'

/**
 * A hotel's rooms (§27) as of a night (the hotel's today unless chosen): capacity (beds and Haji, a season named),
 * status and next change. Filters live in the URL. Add rooms (by range or list) or one; block one or a selection.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const router = useRouter()
const { queryOf, setQuery, searchOf } = useUrlQuery()
const api = useApi()
const notify = useNotify()
const hotelRefresh = useHotelRefresh()
const access = useAccess()
const { hotel, hotelId, ready, isInactive } = useCurrentHotel()
const floors = useFloors(hotelId)
const types = useRoomTypes()
const PAGE_SIZE = 50
const ALL = 'ALL'

const filter = (name: string, fallback = ALL) => computed({ get: () => queryOf(name) ?? fallback, set: (value: string) => setQuery({ [name]: value === fallback ? undefined : value, page: undefined }) })
const floor = filter('floor')
const type = filter('type')
const inventory = filter('inventory', 'IN')
const asOf = computed({ get: () => queryOf('asOf') ?? hotel.value?.today ?? '', set: (value: string) => setQuery({ asOf: value === hotel.value?.today ? undefined : value, page: undefined }) })
// The number search waits for a pause in typing before asking (§27).
const search = searchOf('q', { page: undefined })
const q = computed(() => queryOf('q') ?? '')
const page = computed({ get: () => Number(queryOf('page') ?? 1) || 1, set: (value: number) => setQuery({ page: value === 1 ? undefined : String(value) }) })

const rooms = useApiQuery(
  () => ['rooms', hotelId.value, asOf.value, floor.value, type.value, inventory.value, q.value, page.value],
  () => api<RoomListPage>(`/hotels/${hotelId.value}/rooms`, {
    query: { asOf: asOf.value || undefined, floorId: floor.value === ALL ? undefined : floor.value, roomTypeId: type.value === ALL ? undefined : type.value, q: q.value || undefined, inventory: inventory.value, page: page.value, pageSize: PAGE_SIZE },
  }),
  { enabled: ready, placeholderData: keepPreviousData },
)
const filtered = computed(() => floor.value !== ALL || type.value !== ALL || inventory.value !== 'IN' || !!q.value || !!queryOf('asOf'))
const clearFilters = () => router.replace({ query: {} })
const floorItems = computed(() => [{ value: ALL, label: t('rooms.allFloors') }, ...floors.items.value])
const typeItems = computed(() => [{ value: ALL, label: t('rooms.allTypes') }, ...types.items.value])
const inventoryItems = computed(() => ['IN', 'OUT', 'ALL'].map(value => ({ value, label: t(`rooms.inventory.${value}`) })))

const canManage = computed(() => ready.value && access.value.canInHotel('room.manage', hotelId.value))
const canBlock = computed(() => ready.value && access.value.canInHotel('room.block', hotelId.value))
// The selection (§33): rooms to block together; kept across pages of the same filters, cleared when they change.
const selected = ref<Map<string, BlockRoom>>(new Map())
watch(() => [floor.value, type.value, inventory.value, q.value, asOf.value, hotelId.value], () => {
  if (!selected.value.size) return
  selected.value = new Map()
  notify.done(t('rooms.selectionCleared'))
})
const blockRoomOf = (room: RoomListItem): BlockRoom => ({ id: room.id, roomNumber: room.roomNumber, haji: room.effective?.sellableCapacity ?? null })
function toggle(room: RoomListItem, on: boolean): void {
  const next = new Map(selected.value)
  if (on) next.set(room.id, blockRoomOf(room))
  else next.delete(room.id)
  selected.value = next
}
// Only rooms in inventory can be blocked, so only they can be selected.
const blockable = computed(() => (rooms.data.value?.items ?? []).filter(r => r.inInventory))
const pageSelected = computed(() => blockable.value.length > 0 && blockable.value.every(r => selected.value.has(r.id)))
function togglePage(on: boolean): void {
  const next = new Map(selected.value)
  for (const room of blockable.value) {
    if (on) next.set(room.id, blockRoomOf(room))
    else next.delete(room.id)
  }
  selected.value = next
}

const drawer = ref<'one' | 'many' | 'block' | null>(null)
const blockRooms = ref<BlockRoom[]>([])
function blockOf(list: BlockRoom[]): void {
  blockRooms.value = list
  drawer.value = 'block'
}
async function changed(message: string): Promise<void> {
  notify.done(message)
  selected.value = new Map()
  await hotelRefresh(hotelId.value)
}
const roomLink = (room: RoomListItem) => `/hotels/${encodeURIComponent(hotel.value?.code ?? '')}/rooms/${room.id}`
</script>

<template>
  <HotelFrame :title="t('nav.rooms')">
    <template #actions>
      <template v-if="canManage">
        <UButton icon="i-lucide-plus" :disabled="isInactive" @click="drawer = 'many'">{{ t('rooms.addMany') }}</UButton>
        <UButton color="neutral" variant="outline" :disabled="isInactive" @click="drawer = 'one'">{{ t('rooms.addOne') }}</UButton>
      </template>
    </template>

    <div class="flex flex-wrap gap-2">
      <UInput v-model="search" icon="i-lucide-search" :placeholder="t('rooms.search')" :aria-label="t('rooms.search')" dir="ltr" class="w-44" />
      <USelect v-model="floor" :items="floorItems" :aria-label="t('rooms.floor')" class="w-40" />
      <USelect v-model="type" :items="typeItems" :aria-label="t('rooms.type')" class="w-44" />
      <USelect v-model="inventory" :items="inventoryItems" :aria-label="t('rooms.inventoryLabel')" class="w-40" />
      <UFormField :label="t('rooms.asOf')" class="flex items-center gap-2" :ui="{ wrapper: 'mb-0' }"><UInput v-model="asOf" type="date" dir="ltr" class="w-40" /></UFormField>
      <UButton v-if="filtered" color="neutral" variant="ghost" @click="clearFilters">{{ t('common.clearFilters') }}</UButton>
    </div>

    <div v-if="selected.size" class="surface-panel flex flex-wrap items-center gap-3 p-3" role="status">
      <span class="font-medium">{{ t('rooms.selected', { count: selected.size }, selected.size) }}</span>
      <UButton size="sm" icon="i-lucide-lock" :disabled="isInactive" @click="blockOf([...selected.values()])">{{ t('blocks.blockCount', { count: selected.size }, selected.size) }}</UButton>
      <UButton size="sm" color="neutral" variant="ghost" @click="selected = new Map()">{{ t('rooms.clearSelection') }}</UButton>
    </div>

    <ErrorState v-if="rooms.error.value" :error="rooms.error.value" @retry="rooms.refetch()" />
    <div v-else-if="rooms.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 10" :key="n" class="h-11" /></div>
    <EmptyState v-else-if="!rooms.data.value?.items.length" :title="filtered ? t('rooms.noMatch') : t('rooms.none')" icon="i-lucide-door-closed">
      <UButton v-if="filtered" color="neutral" variant="outline" @click="clearFilters">{{ t('common.clearFilters') }}</UButton>
      <UButton v-else-if="canManage && !isInactive" icon="i-lucide-plus" @click="drawer = 'many'">{{ t('rooms.addMany') }}</UButton>
    </EmptyState>
    <div v-else class="surface-panel overflow-x-auto" :class="{ 'opacity-60': rooms.isPlaceholderData.value }">
      <table class="w-full">
        <thead class="sticky top-0 bg-(--surface-2) text-caption text-(--fg-muted)">
          <tr>
            <th v-if="canBlock" scope="col" class="w-10 px-3 py-2"><UCheckbox :model-value="pageSelected" :disabled="!blockable.length" :aria-label="t('rooms.selectPage')" @update:model-value="value => togglePage(!!value)" /></th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('rooms.room') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('rooms.floor') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('rooms.type') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('capacity.bedsLabel') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('capacity.hajiLabel') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('rooms.status') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('rooms.nextChange') }}</th>
            <th v-if="canBlock" scope="col" class="px-4 py-2"><span class="sr-only">{{ t('common.actions') }}</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--border)">
          <tr v-for="room in rooms.data.value.items" :key="room.id" :class="{ 'bg-(--primary-soft)': selected.has(room.id) }">
            <td v-if="canBlock" class="px-3 py-2"><UCheckbox :model-value="selected.has(room.id)" :disabled="!room.inInventory" :aria-label="t('rooms.selectRoom', { room: room.roomNumber })" @update:model-value="value => toggle(room, !!value)" /></td>
            <td class="px-4 py-2 font-semibold tabular"><NuxtLink :to="roomLink(room)" class="hover:underline" dir="ltr">{{ room.roomNumber }}</NuxtLink></td>
            <td class="whitespace-nowrap px-4 py-2"><bdi>{{ room.floor.label }}</bdi></td>
            <td class="whitespace-nowrap px-4 py-2"><bdi>{{ room.roomType.name }}</bdi></td>
            <td class="px-4 py-2 text-end tabular">{{ room.effective?.physicalBeds ?? '—' }}</td>
            <td class="px-4 py-2 text-end tabular">
              {{ room.effective?.sellableCapacity ?? '—' }}
              <UBadge v-if="room.effective?.period" color="secondary" variant="soft" size="sm" class="ms-1"><bdi>{{ room.effective.period.name }}</bdi></UBadge>
            </td>
            <td class="px-4 py-2"><StatusBadge domain="inventory" :value="room.status" /></td>
            <td class="px-4 py-2"><NextChange :change="room.nextChange" /></td>
            <td v-if="canBlock" class="px-4 py-2 text-end">
              <UButton v-if="room.inInventory" size="sm" color="neutral" variant="ghost" icon="i-lucide-lock" :disabled="isInactive" :aria-label="t('rooms.blockNamed', { room: room.roomNumber })" @click="blockOf([blockRoomOf(room)])">{{ t('rooms.block') }}</UButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <UPagination v-if="(rooms.data.value?.total ?? 0) > PAGE_SIZE" v-model:page="page" :total="rooms.data.value!.total" :items-per-page="PAGE_SIZE" class="self-center" />

    <template v-if="hotel">
      <BulkRoomsDrawer :open="drawer === 'many'" :hotel="hotel" @update:open="value => { if (!value) drawer = null }" @saved="created => changed(t('rooms.created', { count: created.length }, created.length))" />
      <RoomDrawer :open="drawer === 'one'" :hotel="hotel" :room="null" @update:open="value => { if (!value) drawer = null }" @saved="room => changed(t('rooms.savedNamed', { room: room.roomNumber }))" />
      <BlockDrawer :open="drawer === 'block'" :hotel="hotel" :rooms="blockRooms" @update:open="value => { if (!value) drawer = null }" @saved="blocks => changed(t('blocks.saved', { count: blocks.length }, blocks.length))" />
    </template>
  </HotelFrame>
</template>
