<script setup lang="ts">
import type { OrganizationAveragesDto } from '@hajj/contracts/types/inventory'

/**
 * The hotels (§22): find one, open its profile, add one (`hotel.manage` with all hotels). Filters live in the URL.
 * Inventory figures (floors, rooms, Haji capacity tonight, average) only for `room.view`; an inactive hotel has
 * none (it is outside the averages).
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const { queryOf, setQuery } = useUrlQuery()
const router = useRouter()
const api = useApi()
const access = useAccess()
const hotels = useHotels()
useSeoMeta({ title: () => t('hotels.title') })

const seesInventory = computed(() => access.value.can('room.view'))
const averages = useApiQuery(['capacity-averages'], () => api<OrganizationAveragesDto>('/capacity/averages'), { enabled: seesInventory })
const averageOf = (hotelId: string) => averages.data.value?.perHotel.find(p => p.hotelId === hotelId)

type StatusFilter = 'ACTIVE' | 'INACTIVE' | 'ALL'
const q = computed({ get: () => queryOf('q') ?? '', set: value => setQuery({ q: value }) })
const status = computed<StatusFilter>({ get: () => (queryOf('status') ?? 'ACTIVE') as StatusFilter, set: value => setQuery({ status: value === 'ACTIVE' ? undefined : value }) })
// A select item cannot have an empty value: "all cities" is `ALL`, and leaves the URL without `city`.
const ALL = 'ALL'
const city = computed({ get: () => queryOf('city') ?? ALL, set: value => setQuery({ city: value === ALL ? undefined : value }) })
const clearFilters = () => router.replace({ query: {} })

const cities = computed(() => [...new Set(hotels.items.value.map(h => h.city))].sort())
const statusItems = computed(() => (['ACTIVE', 'INACTIVE', 'ALL'] as const).map(value => ({ value, label: t(`hotels.status.${value}`) })))
const cityItems = computed(() => [{ value: ALL, label: t('hotels.allCities') }, ...cities.value.map(value => ({ value, label: value }))])
const shown = computed(() => {
  const needle = q.value.trim().toLowerCase()
  return hotels.items.value.filter(h => (status.value === 'ALL' || h.status === status.value)
    && (city.value === ALL || h.city === city.value)
    && (!needle || h.name.toLowerCase().includes(needle) || h.code.toLowerCase().includes(needle)))
})
const filtered = computed(() => !!(q.value || city.value !== ALL || status.value !== 'ACTIVE'))
const canAdd = computed(() => access.value.can('hotel.manage') && access.value.hasAllHotels)
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="t('hotels.title')">
      <template #actions>
        <UButton v-if="canAdd" to="/hotels/new" icon="i-lucide-plus">{{ t('hotels.add') }}</UButton>
      </template>
    </PageHeader>
    <div class="flex flex-wrap gap-2">
      <UInput v-model="q" icon="i-lucide-search" :placeholder="t('hotels.search')" :aria-label="t('hotels.search')" class="w-64" />
      <USelect v-model="status" :items="statusItems" :aria-label="t('hotels.statusLabel')" class="w-40" />
      <USelect v-model="city" :items="cityItems" :aria-label="t('hotels.city')" class="w-44" />
    </div>

    <ErrorState v-if="hotels.error.value" :error="hotels.error.value" @retry="hotels.refetch()" />
    <ErrorState v-else-if="averages.error.value" :error="averages.error.value" @retry="averages.refetch()" />
    <div v-else-if="hotels.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 5" :key="n" class="h-14" /></div>
    <EmptyState v-else-if="!hotels.items.value.length" :title="canAdd ? t('hotels.none') : t('hotels.noneAssigned')" icon="i-lucide-building-2">
      <UButton v-if="canAdd" to="/hotels/new" icon="i-lucide-plus">{{ t('hotels.add') }}</UButton>
    </EmptyState>
    <EmptyState v-else-if="!shown.length" :title="t('hotels.noMatch')" icon="i-lucide-search-x">
      <UButton v-if="filtered" color="neutral" variant="outline" @click="clearFilters">{{ t('common.clearFilters') }}</UButton>
    </EmptyState>
    <template v-else>
      <div class="surface-panel hidden overflow-x-auto md:block">
        <table class="w-full">
          <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
            <tr>
              <th scope="col" class="px-4 py-2 text-start">{{ t('hotels.column.hotel') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('hotels.city') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('hotels.statusLabel') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('hotels.column.timezone') }}</th>
              <template v-if="seesInventory">
                <th scope="col" class="px-4 py-2 text-end">{{ t('hotels.column.floors') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('hotels.column.rooms') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('hotels.column.capacity') }}</th>
                <th scope="col" class="px-4 py-2 text-end">{{ t('hotels.column.average') }}</th>
              </template>
            </tr>
          </thead>
          <tbody class="divide-y divide-(--border)">
            <tr v-for="hotel in shown" :key="hotel.id" class="hover:bg-(--surface-2)">
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  <HotelMarker :hotel="hotel" size="sm" />
                  <div class="flex flex-col">
                    <NuxtLink :to="`/hotels/${encodeURIComponent(hotel.code)}`" class="font-medium hover:underline"><bdi>{{ hotel.name }}</bdi></NuxtLink>
                    <span class="text-small text-(--fg-muted)" dir="ltr">{{ hotel.code }}</span>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3">{{ hotel.city }}</td>
              <td class="px-4 py-3"><StatusBadge domain="hotel" :value="hotel.status" /></td>
              <td class="px-4 py-3 text-small" dir="ltr">{{ hotel.timezone }}</td>
              <template v-if="seesInventory">
                <td class="px-4 py-3 text-end tabular">{{ hotel.floorCount ?? '—' }}</td>
                <td class="px-4 py-3 text-end tabular">{{ hotel.roomCount ?? '—' }}</td>
                <td class="px-4 py-3 text-end tabular">{{ averageOf(hotel.id)?.dateEffective.numerator ?? '—' }}</td>
                <td class="px-4 py-3 text-end tabular">
                  <UTooltip v-if="averageOf(hotel.id)?.dateEffective.display" :text="t('hotels.normalAverage', { value: averageOf(hotel.id)!.base.display ?? '—' })">
                    <span>{{ averageOf(hotel.id)!.dateEffective.display }}</span>
                  </UTooltip>
                  <span v-else>—</span>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
      <ul class="flex flex-col gap-3 md:hidden">
        <li v-for="hotel in shown" :key="hotel.id">
          <NuxtLink :to="`/hotels/${encodeURIComponent(hotel.code)}`" class="surface-panel flex flex-col gap-2 p-4 hover:bg-(--surface-2)">
            <span class="flex items-center gap-3">
              <HotelMarker :hotel="hotel" size="sm" />
              <span class="flex-1 font-medium"><bdi>{{ hotel.name }}</bdi></span>
              <StatusBadge domain="hotel" :value="hotel.status" />
            </span>
            <span class="text-small text-(--fg-muted)"><span dir="ltr">{{ hotel.code }}</span>, {{ hotel.city }}</span>
            <span v-if="seesInventory" class="text-small tabular">
              {{ t('common.rooms', hotel.roomCount ?? 0) }} · {{ t('hotels.haji', { count: averageOf(hotel.id)?.dateEffective.numerator ?? '—' }) }} · {{ t('hotels.avg', { value: averageOf(hotel.id)?.dateEffective.display ?? '—' }) }}
            </span>
          </NuxtLink>
        </li>
      </ul>
    </template>
  </div>
</template>
