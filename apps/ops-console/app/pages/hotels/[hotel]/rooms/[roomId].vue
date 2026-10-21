<script setup lang="ts">
import type { AuditPageDto } from '@hajj/contracts/types/hotel'
import type { BlockListPage, RoomDetail } from '@hajj/contracts/types/rooms'
import { addDays } from '@hajj/contracts/utils/dates'
import type { BlockRoom } from '../../../../utils/inventory'

/**
 * One room (§28): its identity and status, tonight's capacity and where it comes from, its capacity over time, its
 * normal capacity history, its seasons, its blocks and its history. Block it (`room.block`), change its capacity
 * (`capacity.manage`), edit it, retire it or return it to inventory (`room.manage`).
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const route = useRoute()
const api = useApi()
const format = useFormat()
const notify = useNotify()
const hotelRefresh = useHotelRefresh()
const access = useAccess()
const { hotel, hotelId, ready, isInactive } = useCurrentHotel()
const roomId = computed(() => String(route.params.roomId))
// The API lists blocks over at most 400 nights: the last month and the year ahead.
const HISTORY_NIGHTS = 30
const AHEAD_NIGHTS = 369

const room = useApiQuery(() => ['room', hotelId.value, roomId.value], () => api<RoomDetail>(`/hotels/${hotelId.value}/rooms/${roomId.value}`), { enabled: ready })
const today = computed(() => hotel.value?.today ?? '')
const blocks = useApiQuery(
  () => ['blocks', hotelId.value, 'room', roomId.value, today.value],
  () => api<BlockListPage>(`/hotels/${hotelId.value}/room-blocks`, { query: { roomId: roomId.value, from: addDays(today.value, -HISTORY_NIGHTS), to: addDays(today.value, AHEAD_NIGHTS), pageSize: 200 } }),
  { enabled: computed(() => ready.value && !!today.value) },
)
const seesHistory = computed(() => ready.value && access.value.canInHotel('audit.view', hotelId.value))
const activity = useApiQuery(
  () => ['audit', hotelId.value, 'room', roomId.value],
  () => api<AuditPageDto>(`/hotels/${hotelId.value}/audit-log`, { query: { entityType: 'room', entityId: roomId.value, limit: 10 } }),
  { enabled: seesHistory },
)
const can = (permission: 'room.block' | 'capacity.manage' | 'room.manage') => ready.value && access.value.canInHotel(permission, hotelId.value)
const liveBlocks = computed(() => (blocks.data.value?.items ?? []).filter(b => b.phase === 'RUNNING' || b.phase === 'UPCOMING'))
const pastBlocks = computed(() => (blocks.data.value?.items ?? []).filter(b => b.phase !== 'RUNNING' && b.phase !== 'UPCOMING'))
// The first night out of inventory: still ahead (scheduled) or already reached (retired).
const retiresFrom = computed(() => (room.data.value?.lifecycle.lastNight ? addDays(room.data.value.lifecycle.lastNight, 1) : ''))
const blockRoom = computed<BlockRoom[]>(() => (room.data.value ? [{ id: room.data.value.id, roomNumber: room.data.value.roomNumber, haji: room.data.value.effective?.sellableCapacity ?? null }] : []))

const drawer = ref<'edit' | 'capacity' | 'block' | null>(null)
const lifecycle = ref<'retire' | 'reactivate' | null>(null)
async function changed(message: string): Promise<void> {
  notify.done(message)
  await hotelRefresh(hotelId.value)
}
/** What a retire or return did: retired now, retiring from a later night, or back in inventory. */
function lifecycleMessage(saved: RoomDetail): string {
  const lastNight = saved.lifecycle.lastNight
  if (!lastNight) return t('rooms.reactivated', { room: saved.roomNumber })
  const from = addDays(lastNight, 1)
  return from > today.value ? t('rooms.retireScheduled', { room: saved.roomNumber, date: format.date(from) }) : t('rooms.retired', { room: saved.roomNumber })
}
const base = computed(() => `/hotels/${encodeURIComponent(hotel.value?.code ?? '')}`)
const sourceOf = (detail: RoomDetail) => (detail.effective?.period ? t('rooms.seasonSource', { season: detail.effective.period.name }) : t('rooms.normalSource'))
</script>

<template>
  <HotelFrame :title="room.data.value ? t('rooms.roomNamed', { room: room.data.value.roomNumber }) : t('nav.rooms')">
    <template #actions>
      <template v-if="room.data.value">
        <UButton v-if="can('room.block') && room.data.value.inInventory" icon="i-lucide-lock" :disabled="isInactive" @click="drawer = 'block'">{{ t('rooms.blockRoom') }}</UButton>
        <UButton v-if="can('capacity.manage') && room.data.value.inInventory && !room.data.value.lifecycle.lastNight" color="neutral" variant="outline" :disabled="isInactive" @click="drawer = 'capacity'">{{ t('capacity.change') }}</UButton>
        <template v-if="can('room.manage')">
          <UButton color="neutral" variant="outline" :disabled="isInactive" @click="drawer = 'edit'">{{ t('rooms.editDetails') }}</UButton>
          <UButton v-if="room.data.value.lifecycle.lastNight === null" color="error" variant="ghost" :disabled="isInactive" @click="lifecycle = 'retire'">{{ t('rooms.retire') }}</UButton>
          <UButton v-else color="neutral" variant="ghost" :disabled="isInactive" @click="lifecycle = 'reactivate'">{{ t('rooms.reactivate') }}</UButton>
        </template>
      </template>
    </template>

    <UButton :to="`${base}/rooms`" color="neutral" variant="link" icon="i-lucide-arrow-left" :ui="{ leadingIcon: 'rtl:-scale-x-100' }" class="self-start">{{ t('rooms.backToRooms') }}</UButton>
    <EmptyState v-if="room.error.value && toApiError(room.error.value).status === 404" :title="t('rooms.notFound', { hotel: hotel?.name ?? '' })" icon="i-lucide-door-closed" />
    <ErrorState v-else-if="room.error.value" :error="room.error.value" @retry="room.refetch()" />
    <USkeleton v-else-if="!room.data.value" class="h-40" />
    <template v-else>
      <section class="surface-panel flex flex-wrap items-center gap-x-6 gap-y-2 p-5">
        <span class="text-page-title tabular" dir="ltr">{{ room.data.value.roomNumber }}</span>
        <span><bdi>{{ room.data.value.roomType.name }}</bdi> · <bdi>{{ room.data.value.floor.label }}</bdi></span>
        <StatusBadge domain="inventory" :value="room.data.value.status" />
        <span v-if="room.data.value.features.length" class="text-small text-(--fg-muted)">{{ room.data.value.features.map(f => t(`rooms.feature.${f}`)).join(', ') }}</span>
        <span v-if="retiresFrom" class="text-small text-(--fg-muted)">{{ retiresFrom > today ? t('rooms.retiresFrom', { date: format.date(retiresFrom) }) : t('rooms.retiredFrom', { date: format.date(retiresFrom) }) }}</span>
      </section>
      <section class="surface-panel flex flex-wrap items-baseline gap-x-6 gap-y-1 p-5" aria-labelledby="tonight-heading">
        <h2 id="tonight-heading" class="text-subsection">{{ t('overview.tonight', { date: format.date(today, 'long') }) }}</h2>
        <CapacityValue :haji="room.data.value.effective?.sellableCapacity" :beds="room.data.value.effective?.physicalBeds" class="text-section" />
        <span class="text-small" :class="room.data.value.effective?.period ? 'text-(--season)' : 'text-(--fg-muted)'">{{ room.data.value.effective ? sourceOf(room.data.value) : t('status.inventory.NOT_IN_INVENTORY') }}</span>
        <span class="text-small text-(--fg-muted)">{{ t('rooms.nextChange') }}: <NextChange :change="room.data.value.nextChange" /></span>
      </section>

      <CapacityTimeline :hotel-id="hotelId" :room-id="roomId" :today="today" />

      <div class="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="normal-heading" class="surface-panel flex flex-col gap-3 p-5">
          <h2 id="normal-heading" class="text-section">{{ t('capacity.normal') }}</h2>
          <ul class="flex flex-col gap-2">
            <li v-for="version in [...room.data.value.baseVersions].reverse()" :key="version.id" class="flex flex-wrap items-baseline gap-x-3 text-small">
              <span class="tabular">{{ version.validTo ? `${format.date(version.validFrom, 'short')} – ${format.date(version.validTo)}` : t('capacity.since', { date: format.date(version.validFrom) }) }}</span>
              <CapacityValue :haji="version.sellableCapacity" :beds="version.physicalBeds" />
              <span v-if="version.reason" class="text-(--fg-muted)"><bdi>{{ version.reason }}</bdi></span>
            </li>
          </ul>
        </section>
        <section aria-labelledby="room-seasons-heading" class="surface-panel flex flex-col gap-3 p-5">
          <h2 id="room-seasons-heading" class="text-section">{{ t('rooms.seasons') }}</h2>
          <p v-if="!room.data.value.seasons.length" class="text-(--fg-muted)">{{ t('rooms.noSeasons') }}</p>
          <ul v-else class="flex flex-col gap-2">
            <li v-for="season in room.data.value.seasons" :key="season.overrideId" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
              <NuxtLink :to="`${base}/seasons/${season.period.id}`" class="font-medium hover:underline"><bdi>{{ season.period.name }}</bdi></NuxtLink>
              <StatusBadge domain="season" :value="season.period.phase" />
              <NightsRange :from="season.period.startDate" :to="season.period.endDate" :count="false" />
              <CapacityValue :haji="season.sellableCapacity" :beds="season.physicalBeds" />
            </li>
          </ul>
        </section>
      </div>

      <section aria-labelledby="room-blocks-heading" class="surface-panel flex flex-col gap-3 p-5">
        <h2 id="room-blocks-heading" class="text-section">{{ t('nav.blocks') }}</h2>
        <ErrorState v-if="blocks.error.value" :error="blocks.error.value" @retry="blocks.refetch()" />
        <p v-else-if="blocks.data.value && !blocks.data.value.items.length" class="text-(--fg-muted)">{{ t('rooms.noBlocks') }}</p>
        <ul v-else class="flex flex-col gap-2">
          <li v-for="block in [...liveBlocks, ...pastBlocks]" :key="block.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
            <StatusBadge domain="inventory" :value="block.kind" />
            <NightsRange :from="block.startDate" :to="block.endDate" />
            <StatusBadge domain="block" :value="block.phase" />
            <bdi class="text-(--fg-muted)">{{ block.reason }}</bdi>
          </li>
        </ul>
      </section>

      <section v-if="seesHistory" aria-labelledby="room-activity-heading" class="surface-panel flex flex-col gap-3 p-5">
        <div class="flex items-baseline justify-between gap-2">
          <h2 id="room-activity-heading" class="text-section">{{ t('hotel.tab.activity') }}</h2>
          <NuxtLink :to="`${base}/activity`" class="text-small text-(--primary) hover:underline">{{ t('rooms.allActivity') }}</NuxtLink>
        </div>
        <ErrorState v-if="activity.error.value" :error="activity.error.value" @retry="activity.refetch()" />
        <p v-else-if="activity.data.value && !activity.data.value.items.length" class="text-(--fg-muted)">{{ t('activity.none') }}</p>
        <ul v-else class="flex flex-col gap-1 text-small">
          <li v-for="entry in activity.data.value?.items" :key="entry.id" class="flex flex-wrap gap-x-3">
            <span class="font-medium">{{ t(`activity.action.${entry.action}`) }}</span>
            <span class="tabular text-(--fg-muted)">{{ format.dateTime(entry.createdAt, hotel?.timezone) }}</span>
            <bdi class="text-(--fg-muted)">{{ entry.actor?.fullName ?? t('activity.system') }}</bdi>
          </li>
        </ul>
      </section>

      <template v-if="hotel">
        <RoomDrawer :open="drawer === 'edit'" :hotel="hotel" :room="room.data.value" @update:open="value => { if (!value) drawer = null }" @saved="saved => changed(t('rooms.savedNamed', { room: saved.roomNumber }))" />
        <CapacityDrawer :open="drawer === 'capacity'" :hotel="hotel" :room="room.data.value" @update:open="value => { if (!value) drawer = null }" @saved="saved => changed(t('capacity.saved', { room: saved.roomNumber }))" />
        <BlockDrawer :open="drawer === 'block'" :hotel="hotel" :rooms="blockRoom" @update:open="value => { if (!value) drawer = null }" @saved="saved => changed(t('blocks.saved', { count: saved.length }, saved.length))" />
        <RoomLifecycleDialog :hotel="hotel" :room="room.data.value" :blocks="liveBlocks" :mode="lifecycle" @close="lifecycle = null" @done="saved => { lifecycle = null; void changed(lifecycleMessage(saved)) }" />
      </template>
    </template>
  </HotelFrame>
</template>
