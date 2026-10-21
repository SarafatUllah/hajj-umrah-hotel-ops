<script setup lang="ts">
import type { CapacityPeriodDto } from '@hajj/contracts/types/inventory'
import { signed } from '../../../../utils/inventory'

/**
 * A hotel's seasons (§30.1): running and upcoming (or ended), each with its label, nights, phase, rooms and capacity
 * change. A season gives chosen rooms different capacity for set dates, then they return to normal by themselves.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const api = useApi()
const notify = useNotify()
const hotelRefresh = useHotelRefresh()
const access = useAccess()
const { hotel, hotelId, ready, isInactive } = useCurrentHotel()
const showPast = computed({ get: () => route.query.show === 'past', set: value => void router.replace({ query: value ? { show: 'past' } : {} }) })
const seasons = useApiQuery(() => ['seasons', hotelId.value, showPast.value], () => api<CapacityPeriodDto[]>(`/hotels/${hotelId.value}/capacity-periods`, { query: { includePast: String(showPast.value) } }), { enabled: ready })
const shown = computed(() => (seasons.data.value ?? []).filter(s => (showPast.value ? s.phase === 'ENDED' : s.phase !== 'ENDED')))
const canManage = computed(() => ready.value && access.value.canInHotel('capacity.manage', hotelId.value))
const creating = ref(false)
async function created(season: CapacityPeriodDto): Promise<void> {
  notify.done(t('seasons.created', { name: season.name }))
  await hotelRefresh(hotelId.value)
  await navigateTo(`/hotels/${encodeURIComponent(hotel.value!.code)}/seasons/${season.id}`)
}
</script>

<template>
  <HotelFrame :title="t('nav.seasons')">
    <template #actions>
      <UButton v-if="canManage" icon="i-lucide-plus" :disabled="isInactive" @click="creating = true">{{ t('seasons.new') }}</UButton>
    </template>
    <p class="max-w-prose text-(--fg-muted)">{{ t('seasons.intro') }}</p>
    <URadioGroup :model-value="showPast ? 'past' : 'current'" :items="[{ value: 'current', label: t('seasons.current') }, { value: 'past', label: t('seasons.past') }]" orientation="horizontal" variant="table" :aria-label="t('seasons.show')" @update:model-value="value => showPast = value === 'past'" />
    <ErrorState v-if="seasons.error.value" :error="seasons.error.value" @retry="seasons.refetch()" />
    <div v-else-if="seasons.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 4" :key="n" class="h-12" /></div>
    <EmptyState v-else-if="!shown.length" :title="t('seasons.none')" icon="i-lucide-calendar-range">
      <UButton v-if="canManage && !showPast && !isInactive" icon="i-lucide-plus" @click="creating = true">{{ t('seasons.new') }}</UButton>
    </EmptyState>
    <div v-else class="surface-panel overflow-x-auto">
      <table class="w-full">
        <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
          <tr>
            <th scope="col" class="px-4 py-2 text-start">{{ t('seasons.name') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('seasons.label') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('seasons.dates') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('blocks.phase') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('hotels.column.rooms') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('seasons.change') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--border)">
          <tr v-for="season in shown" :key="season.id">
            <td class="px-4 py-3 font-medium"><NuxtLink :to="`/hotels/${encodeURIComponent(hotel?.code ?? '')}/seasons/${season.id}`" class="hover:underline"><bdi>{{ season.name }}</bdi></NuxtLink></td>
            <td class="px-4 py-3"><UBadge color="secondary" variant="outline">{{ t(`seasons.kind.${season.kind}`) }}</UBadge></td>
            <td class="px-4 py-3"><NightsRange :from="season.startDate" :to="season.endDate" /></td>
            <td class="px-4 py-3"><StatusBadge domain="season" :value="season.phase" /></td>
            <td class="px-4 py-3 text-end tabular">{{ season.overrideCount }}</td>
            <td class="px-4 py-3 text-end tabular text-(--season)"><bdi dir="ltr">{{ signed(season.impact.sellableDelta) }}</bdi> {{ t('capacity.hajiShort') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <SeasonDrawer v-if="hotel" v-model:open="creating" :hotel="hotel" :season="null" @saved="created" />
  </HotelFrame>
</template>
