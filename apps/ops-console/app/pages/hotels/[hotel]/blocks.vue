<script setup lang="ts">
import { keepPreviousData } from '@tanstack/vue-query'
import { BLOCK_KINDS } from '@hajj/contracts/constants/inventory'
import type { BlockListItem, BlockListPage } from '@hajj/contracts/types/rooms'
import { addDays, todayInTimezone } from '@hajj/contracts/utils/dates'

/**
 * Blocks and maintenance (§32.2): what is out of order now and next (tonight to 400 nights ahead), or the history
 * (the last 90 nights, cancelled ones on request). Cancel or end early with `room.block`; the server says which.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const { queryOf, setQuery, pageOf } = useUrlQuery()
const api = useApi()
const format = useFormat()
const notify = useNotify()
const hotelRefresh = useHotelRefresh()
const access = useAccess()
const { hotel, hotelId, ready, isInactive } = useCurrentHotel()
const PAGE_SIZE = 50
const HISTORY_NIGHTS = 90
const NOW_NIGHTS = 400

const view = computed<'now' | 'history'>({ get: () => (queryOf('view') === 'history' ? 'history' : 'now'), set: value => setQuery({ view: value === 'now' ? undefined : value, page: undefined }) })
const kind = computed({ get: () => queryOf('kind') ?? 'ALL', set: value => setQuery({ kind: value === 'ALL' ? undefined : value, page: undefined }) })
const includeCancelled = computed({ get: () => queryOf('cancelled') === '1', set: value => setQuery({ cancelled: value ? '1' : undefined, page: undefined }) })
const page = pageOf()
const nightsShown = computed(() => {
  const today = hotel.value?.today ?? ''
  return view.value === 'now' ? { from: today, to: today && addDays(today, NOW_NIGHTS - 1) } : { from: today && addDays(today, -HISTORY_NIGHTS), to: today && addDays(today, -1) }
})
const blocks = useApiQuery(
  () => ['blocks', hotelId.value, nightsShown.value.from, nightsShown.value.to, kind.value, view.value === 'history' && includeCancelled.value, page.value],
  () => api<BlockListPage>(`/hotels/${hotelId.value}/room-blocks`, {
    query: { from: nightsShown.value.from, to: nightsShown.value.to, kind: kind.value === 'ALL' ? undefined : kind.value, includeCancelled: view.value === 'history' && includeCancelled.value ? 'true' : undefined, page: page.value, pageSize: PAGE_SIZE },
  }),
  { enabled: ready, placeholderData: keepPreviousData },
)
const canBlock = computed(() => ready.value && access.value.canInHotel('room.block', hotelId.value))
const kinds = computed(() => [{ value: 'ALL', label: t('blocks.allKinds') }, ...BLOCK_KINDS.map(value => ({ value, label: t(`status.inventory.${value}`) }))])
const views = computed(() => [{ value: 'now', label: t('blocks.now') }, { value: 'history', label: t('blocks.history') }])

const blocking = ref(false)
const cancelling = ref<BlockListItem | null>(null)
async function changed(message: string): Promise<void> {
  notify.done(message)
  await hotelRefresh(hotelId.value)
}
/** The hotel's date of a moment (an early end at 01:00 in Makkah is that day there, not the day before in UTC). */
const hotelDateOf = (at: string) => todayInTimezone(hotel.value!.timezone, new Date(at))
const roomLink = (block: BlockListItem) => `/hotels/${encodeURIComponent(hotel.value?.code ?? '')}/rooms/${block.room.id}`
</script>

<template>
  <HotelFrame :title="t('nav.blocks')">
    <template #actions>
      <UButton v-if="canBlock" icon="i-lucide-lock" :disabled="isInactive" @click="blocking = true">{{ t('blocks.title') }}</UButton>
    </template>
    <div class="flex flex-wrap items-center gap-2">
      <URadioGroup v-model="view" :items="views" orientation="horizontal" variant="table" :aria-label="t('blocks.view')" />
      <USelect v-model="kind" :items="kinds" :aria-label="t('blocks.kind')" class="w-48" />
      <USwitch v-if="view === 'history'" v-model="includeCancelled" :label="t('blocks.includeCancelled')" />
    </div>
    <ErrorState v-if="blocks.error.value" :error="blocks.error.value" @retry="blocks.refetch()" />
    <div v-else-if="blocks.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 6" :key="n" class="h-12" /></div>
    <EmptyState v-else-if="!blocks.data.value?.items.length" :title="kind !== 'ALL' ? t('blocks.noMatch') : t('blocks.none')" icon="i-lucide-lock-open">
      <UButton v-if="kind !== 'ALL'" color="neutral" variant="outline" @click="kind = 'ALL'">{{ t('common.clearFilters') }}</UButton>
    </EmptyState>
    <div v-else class="surface-panel overflow-x-auto" :class="{ 'opacity-60': blocks.isPlaceholderData.value }">
      <table class="w-full">
        <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
          <tr>
            <th scope="col" class="px-4 py-2 text-start">{{ t('rooms.room') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('blocks.kind') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('blocks.nights') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('blocks.reason') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('blocks.phase') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('blocks.createdBy') }}</th>
            <th v-if="canBlock" scope="col" class="px-4 py-2"><span class="sr-only">{{ t('common.actions') }}</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--border)">
          <tr v-for="block in blocks.data.value.items" :key="block.id">
            <td class="px-4 py-3 font-medium tabular"><NuxtLink :to="roomLink(block)" class="hover:underline" dir="ltr">{{ block.room.roomNumber }}</NuxtLink></td>
            <td class="px-4 py-3"><StatusBadge domain="inventory" :value="block.kind" /></td>
            <td class="px-4 py-3"><NightsRange :from="block.startDate" :to="block.endDate" /></td>
            <td class="px-4 py-3">
              <bdi>{{ block.reason }}</bdi>
              <p v-if="block.endedEarly" class="text-small text-(--fg-muted)">{{ t('blocks.endedEarlyNote', { date: format.date(hotelDateOf(block.endedEarly.at), 'short'), planned: format.date(block.endedEarly.originalEndDate, 'short'), reason: block.endedEarly.reason }) }}</p>
              <p v-else-if="block.cancelReason" class="text-small text-(--fg-muted)">{{ t('blocks.cancelledNote', { reason: block.cancelReason }) }}</p>
            </td>
            <td class="px-4 py-3"><StatusBadge domain="block" :value="block.phase" /></td>
            <td class="px-4 py-3 text-small"><bdi>{{ block.createdBy?.fullName ?? '—' }}</bdi></td>
            <td v-if="canBlock" class="px-4 py-3 text-end">
              <UButton v-if="block.cancelAction" size="sm" color="neutral" variant="ghost" :disabled="isInactive" :aria-label="block.cancelAction === 'END_EARLY' ? t('blocks.endEarlyTitle', { room: block.room.roomNumber }) : t('blocks.cancelTitle', { room: block.room.roomNumber })" @click="cancelling = block">
                {{ block.cancelAction === 'END_EARLY' ? t('blocks.endEarly') : t('blocks.cancelBlock') }}
              </UButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <UPagination v-if="(blocks.data.value?.total ?? 0) > PAGE_SIZE" v-model:page="page" :total="blocks.data.value!.total" :items-per-page="PAGE_SIZE" class="self-center" />

    <template v-if="hotel">
      <BlockDrawer v-model:open="blocking" :hotel="hotel" @saved="saved => changed(t('blocks.saved', { count: saved.length }, saved.length))" />
      <CancelBlockDialog :hotel="hotel" :block="cancelling" @close="cancelling = null" @done="block => { cancelling = null; void changed(block.phase === 'ENDED_EARLY' ? t('blocks.endedEarly', { room: block.room.roomNumber }) : t('blocks.cancelled', { room: block.room.roomNumber })) }" />
    </template>
  </HotelFrame>
</template>
