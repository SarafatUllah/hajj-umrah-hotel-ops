<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import type { CapacityPeriodDto, OverrideListItem } from '@hajj/contracts/types/inventory'

/**
 * A season (§30.3–§30.4): its dates, phase and summary on the first night, and its rooms with their seasonal
 * capacity. While upcoming: apply capacity to rooms, remove rooms (tier 1), delete it when empty. While running: end
 * it after tonight (tier 2). Ended: history. Every write needs `capacity.manage`.
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
const periodId = computed(() => String(route.params.periodId))
const season = useApiQuery(() => ['season', hotelId.value, periodId.value], () => api<CapacityPeriodDto>(`/hotels/${hotelId.value}/capacity-periods/${periodId.value}`), { enabled: ready })
const rooms = useApiQuery(() => ['season-rooms', hotelId.value, periodId.value], () => api<OverrideListItem[]>(`/hotels/${hotelId.value}/capacity-periods/${periodId.value}/overrides`), { enabled: ready })
const canManage = computed(() => ready.value && access.value.canInHotel('capacity.manage', hotelId.value) && !isInactive.value)
const phase = computed(() => season.data.value?.phase)
const base = computed(() => `/hotels/${encodeURIComponent(hotel.value?.code ?? '')}`)
const signed = (value: number) => (value > 0 ? `+${value}` : String(value))

const editing = ref(false)
const selected = ref<Set<string>>(new Set())
const toggle = (id: string, on: boolean) => {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}
async function changed(message: string): Promise<void> {
  notify.done(message)
  selected.value = new Set()
  await hotelRefresh(hotelId.value)
}
const confirming = ref<'remove' | 'end' | 'delete' | null>(null)
const act = useMutation({
  mutationFn: async (action: 'remove' | 'end' | 'delete') => {
    const path = `/hotels/${hotelId.value}/capacity-periods/${periodId.value}`
    if (action === 'remove') return api(`${path}/overrides/remove`, { method: 'POST', body: { overrideIds: [...selected.value] } })
    if (action === 'end') return api(path, { method: 'PATCH', body: { endDate: hotel.value!.today } })
    return api(path, { method: 'DELETE' })
  },
  onSuccess: async (_result, action) => {
    confirming.value = null
    const name = season.data.value?.name ?? ''
    if (action === 'delete') {
      notify.done(t('seasons.deleted', { name }))
      // Leave first: refreshing here would ask for the season just deleted.
      await navigateTo(`${base.value}/seasons`)
      await hotelRefresh(hotelId.value)
      return
    }
    await changed(action === 'end' ? t('seasons.ended', { name }) : t('seasons.removed', { count: selected.value.size }, selected.value.size))
  },
  onError: (error) => {
    confirming.value = null
    notify.failed(error)
  },
})
const dialog = computed(() => {
  const name = season.data.value?.name ?? ''
  if (confirming.value === 'remove') return { title: t('seasons.removeTitle', { count: selected.value.size }, selected.value.size), text: t('seasons.removeText', { name, hotel: hotel.value?.name ?? '' }), label: t('seasons.removeNamed', { count: selected.value.size }, selected.value.size), tier: 1 as const }
  if (confirming.value === 'end') return { title: t('seasons.endTitle', { name }), text: t('seasons.endText', { name, tonight: format.date(hotel.value?.today ?? '', 'short'), count: season.data.value?.overrideCount ?? 0 }), label: t('seasons.endNamed', { name }), tier: 2 as const }
  return { title: t('seasons.deleteTitle', { name }), text: t('seasons.deleteText', { name, hotel: hotel.value?.name ?? '' }), label: t('seasons.deleteNamed', { name }), tier: 1 as const }
})
</script>

<template>
  <HotelFrame :title="season.data.value?.name ?? t('nav.seasons')">
    <template #actions>
      <template v-if="season.data.value && canManage">
        <UButton v-if="phase === 'FUTURE'" :to="`${base}/seasons/${periodId}/apply`" icon="i-lucide-layers-plus">{{ t('seasons.apply') }}</UButton>
        <UButton color="neutral" variant="outline" @click="editing = true">{{ t('seasons.editDetails') }}</UButton>
        <UButton v-if="phase === 'ACTIVE'" color="error" variant="ghost" @click="confirming = 'end'">{{ t('seasons.endEarly') }}</UButton>
        <UButton v-if="phase === 'FUTURE' && !season.data.value.overrideCount" color="error" variant="ghost" @click="confirming = 'delete'">{{ t('seasons.delete') }}</UButton>
      </template>
    </template>
    <UButton :to="`${base}/seasons`" color="neutral" variant="link" icon="i-lucide-arrow-left" :ui="{ leadingIcon: 'rtl:-scale-x-100' }" class="self-start">{{ t('seasons.back') }}</UButton>
    <ErrorState v-if="season.error.value" :error="season.error.value" @retry="season.refetch()" />
    <USkeleton v-else-if="!season.data.value" class="h-32" />
    <template v-else>
      <section class="surface-panel flex flex-wrap items-center gap-x-5 gap-y-2 p-5">
        <UBadge color="secondary" variant="outline">{{ t(`seasons.kind.${season.data.value.kind}`) }}</UBadge>
        <NightsRange :from="season.data.value.startDate" :to="season.data.value.endDate" />
        <StatusBadge domain="season" :value="season.data.value.phase" />
        <span class="text-small">{{ t('seasons.summary', { rooms: season.data.value.overrideCount, haji: signed(season.data.value.impact.sellableDelta), beds: signed(season.data.value.impact.bedsDelta) }) }}</span>
        <p v-if="season.data.value.notes" class="w-full text-small text-(--fg-muted)"><bdi>{{ season.data.value.notes }}</bdi></p>
      </section>
      <UAlert v-if="phase === 'ACTIVE'" color="info" variant="soft" icon="i-lucide-lock" :title="t('seasons.runningBanner')" />
      <UAlert v-else-if="phase === 'ENDED'" color="neutral" variant="soft" icon="i-lucide-history" :title="t('seasons.endedBanner')" />

      <section aria-labelledby="season-rooms-heading" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 id="season-rooms-heading" class="text-section">{{ t('seasons.rooms') }}</h2>
          <UButton v-if="phase === 'FUTURE' && canManage && selected.size" size="sm" color="error" variant="outline" @click="confirming = 'remove'">{{ t('seasons.removeNamed', { count: selected.size }, selected.size) }}</UButton>
        </div>
        <ErrorState v-if="rooms.error.value" :error="rooms.error.value" @retry="rooms.refetch()" />
        <USkeleton v-else-if="rooms.isPending.value" class="h-24" />
        <EmptyState v-else-if="!rooms.data.value?.length" :title="t('seasons.noRooms')" icon="i-lucide-door-closed">
          <UButton v-if="phase === 'FUTURE' && canManage" :to="`${base}/seasons/${periodId}/apply`">{{ t('seasons.apply') }}</UButton>
        </EmptyState>
        <div v-else class="surface-panel overflow-x-auto">
          <table class="w-full">
            <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
              <tr>
                <th v-if="phase === 'FUTURE' && canManage" scope="col" class="w-10 px-3 py-2"><span class="sr-only">{{ t('rooms.select') }}</span></th>
                <th scope="col" class="px-4 py-2 text-start">{{ t('rooms.room') }}</th>
                <th scope="col" class="px-4 py-2 text-start">{{ t('seasons.seasonalCapacity') }}</th>
                <th scope="col" class="px-4 py-2 text-start">{{ t('capacity.reason') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-(--border)">
              <tr v-for="room in rooms.data.value" :key="room.id">
                <td v-if="phase === 'FUTURE' && canManage" class="px-3 py-2"><UCheckbox :model-value="selected.has(room.id)" :aria-label="t('rooms.selectRoom', { room: room.roomNumber })" @update:model-value="value => toggle(room.id, !!value)" /></td>
                <td class="px-4 py-2 font-semibold tabular"><NuxtLink :to="`${base}/rooms/${room.roomId}`" class="hover:underline" dir="ltr">{{ room.roomNumber }}</NuxtLink></td>
                <td class="px-4 py-2"><CapacityValue :haji="room.sellableCapacity" :beds="room.physicalBeds" /></td>
                <td class="px-4 py-2 text-small text-(--fg-muted)"><bdi>{{ room.reason ?? '—' }}</bdi></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <template v-if="hotel">
        <SeasonDrawer v-model:open="editing" :hotel="hotel" :season="season.data.value" @saved="saved => changed(t('seasons.saved', { name: saved.name }))" />
        <ConfirmDialog
          :open="!!confirming"
          :title="dialog.title"
          :description="dialog.text"
          :confirm-label="dialog.label"
          :tier="dialog.tier"
          destructive
          :pending="act.isPending.value"
          @update:open="value => { if (!value) confirming = null }"
          @confirm="confirming && act.mutate(confirming)"
        />
      </template>
    </template>
  </HotelFrame>
</template>
