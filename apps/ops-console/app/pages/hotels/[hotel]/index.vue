<script setup lang="ts">
import type { HotelDetail } from '@hajj/contracts/types/hotel'
import type { CapacityPeriodDto, DailySummaryDto, HotelAveragesDto } from '@hajj/contracts/types/inventory'

/**
 * A hotel's profile, Overview tab (§23): tonight's figures, its structure (or the setup checklist while it has no
 * floors or rooms), its details and its seasons. Inventory panels only for `room.view` in this hotel.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const access = useAccess()
const format = useFormat()
const { hotel, hotelId, ready } = useCurrentHotel()
const seesInventory = computed(() => ready.value && access.value.canInHotel('room.view', hotelId.value))
const today = computed(() => hotel.value?.today ?? '')

const detail = useApiQuery(() => ['hotel', hotelId.value], () => api<HotelDetail>(`/hotels/${hotelId.value}`), { enabled: ready })
const tonight = useApiQuery(() => ['daily-summary', hotelId.value, today.value, today.value], () => api<DailySummaryDto>(`/hotels/${hotelId.value}/inventory/daily-summary`, { query: { from: today.value, to: today.value } }), { enabled: seesInventory })
const averages = useApiQuery(() => ['hotel-averages', hotelId.value], () => api<HotelAveragesDto>(`/hotels/${hotelId.value}/capacity/averages`), { enabled: seesInventory })
const seasons = useApiQuery(() => ['seasons', hotelId.value, true], () => api<CapacityPeriodDto[]>(`/hotels/${hotelId.value}/capacity-periods`, { query: { includePast: 'true' } }), { enabled: seesInventory })

const night = computed(() => tonight.data.value?.days[0])
const metrics = computed(() => (night.value
  ? [
      { label: t('overview.roomsInInventory'), value: night.value.roomsInInventory },
      { label: t('overview.sellable'), value: t('overview.ofRooms', { sellable: night.value.sellableRooms, total: night.value.roomsInInventory }) },
      { label: t('overview.capacity'), value: night.value.effectiveSellableCapacity, hint: t('overview.capacityHint') },
      { label: t('overview.average'), value: averages.data.value?.dateEffective.display ?? '—', hint: t('overview.normal', { value: averages.data.value?.base.display ?? '—' }) },
    ]
  : []))
const needsSetup = computed(() => detail.data.value && (detail.data.value.floorCount === 0 || detail.data.value.roomCount === 0))
const base = computed(() => `/hotels/${encodeURIComponent(hotel.value?.code ?? '')}`)
</script>

<template>
  <HotelFrame tab="overview">
    <template v-if="seesInventory">
      <section aria-labelledby="tonight-heading" class="flex flex-col gap-2">
        <h2 id="tonight-heading" class="text-section">{{ t('overview.tonight', { date: today ? format.date(today, 'long') : '' }) }}</h2>
        <ErrorState v-if="tonight.error.value" :error="tonight.error.value" @retry="tonight.refetch()" />
        <USkeleton v-else-if="!night" class="h-24" />
        <MetricStrip v-else :items="metrics" />
      </section>
    </template>

    <div class="grid gap-6 lg:grid-cols-2">
      <section v-if="seesInventory" aria-labelledby="structure-heading" class="surface-panel flex flex-col gap-3 p-5">
        <h2 id="structure-heading" class="text-section">{{ needsSetup ? t('hotel.setup.title') : t('hotel.structure') }}</h2>
        <ErrorState v-if="detail.error.value" :error="detail.error.value" @retry="detail.refetch()" />
        <USkeleton v-else-if="!detail.data.value" class="h-24" />
        <ol v-else-if="needsSetup" class="flex list-decimal flex-col gap-2 ps-5">
          <li><span :class="{ 'line-through text-(--fg-muted)': detail.data.value.floorCount }">{{ t('hotel.setup.floors') }}</span> <NuxtLink v-if="!detail.data.value.floorCount" :to="`${base}/floors`" class="text-(--primary) hover:underline">{{ t('hotel.setup.go') }}</NuxtLink></li>
          <li><span :class="{ 'line-through text-(--fg-muted)': detail.data.value.roomCount }">{{ t('hotel.setup.rooms') }}</span></li>
          <li>{{ t('hotel.setup.seasons') }}</li>
        </ol>
        <dl v-else class="grid grid-cols-2 gap-3">
          <div><dt class="text-small text-(--fg-muted)">{{ t('hotel.floors') }}</dt><dd class="tabular"><NuxtLink :to="`${base}/floors`" class="hover:underline">{{ detail.data.value.floorCount ?? '—' }}</NuxtLink></dd></div>
          <div><dt class="text-small text-(--fg-muted)">{{ t('hotel.rooms') }}</dt><dd class="tabular">{{ detail.data.value.roomCount ?? '—' }}</dd></div>
        </dl>
      </section>

      <section aria-labelledby="details-heading" class="surface-panel flex flex-col gap-3 p-5">
        <h2 id="details-heading" class="text-section">{{ t('hotel.details') }}</h2>
        <USkeleton v-if="!detail.data.value" class="h-24" />
        <dl v-else class="grid grid-cols-2 gap-3 text-small">
          <div><dt class="text-(--fg-muted)">{{ t('hotel.field.timezone') }}</dt><dd><bdi dir="ltr">{{ detail.data.value.timezone }}</bdi></dd></div>
          <div><dt class="text-(--fg-muted)">{{ t('hotel.checkTimes') }}</dt><dd class="tabular">{{ detail.data.value.checkInTime }} / {{ detail.data.value.checkOutTime }}</dd></div>
          <div v-if="detail.data.value.address" class="col-span-2"><dt class="text-(--fg-muted)">{{ t('hotel.field.address') }}</dt><dd>{{ detail.data.value.address }}</dd></div>
          <div v-if="detail.data.value.phone"><dt class="text-(--fg-muted)">{{ t('hotel.field.phone') }}</dt><dd><bdi dir="ltr">{{ detail.data.value.phone }}</bdi></dd></div>
          <div v-if="detail.data.value.email"><dt class="text-(--fg-muted)">{{ t('hotel.field.email') }}</dt><dd><bdi dir="ltr">{{ detail.data.value.email }}</bdi></dd></div>
          <div><dt class="text-(--fg-muted)">{{ t('hotel.field.ownership') }}</dt><dd>{{ t(`hotel.ownership.${detail.data.value.ownershipType}`) }}</dd></div>
          <div><dt class="text-(--fg-muted)">{{ t('hotel.field.currency') }}</dt><dd><bdi dir="ltr">{{ detail.data.value.currency }}</bdi></dd></div>
        </dl>
      </section>
    </div>

    <section v-if="seesInventory" aria-labelledby="seasons-heading" class="flex flex-col gap-3">
      <h2 id="seasons-heading" class="text-section">{{ t('hotel.seasons') }}</h2>
      <ErrorState v-if="seasons.error.value" :error="seasons.error.value" @retry="seasons.refetch()" />
      <USkeleton v-else-if="seasons.isPending.value" class="h-16" />
      <EmptyState v-else-if="!seasons.data.value?.length" :title="t('hotel.noSeasons')" icon="i-lucide-calendar-range" />
      <ul v-else class="surface-panel divide-y divide-(--border)">
        <li v-for="season in seasons.data.value" :key="season.id" class="flex flex-wrap items-center gap-x-4 gap-y-1 p-4">
          <span class="min-w-40 font-medium"><bdi>{{ season.name }}</bdi></span>
          <StatusBadge domain="season" :value="season.phase" />
          <NightsRange :from="season.startDate" :to="season.endDate" />
          <span class="text-small text-(--fg-muted)">{{ t('common.rooms', season.overrideCount) }}</span>
          <span class="tabular text-small text-(--season)"><bdi dir="ltr">{{ season.impact.sellableDelta > 0 ? `+${season.impact.sellableDelta}` : season.impact.sellableDelta }}</bdi> {{ t('hotel.haji') }}</span>
        </li>
      </ul>
    </section>
  </HotelFrame>
</template>
