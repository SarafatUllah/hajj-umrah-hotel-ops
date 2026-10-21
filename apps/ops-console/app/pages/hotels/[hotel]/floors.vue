<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import type { FloorListItem } from '@hajj/contracts/types/hotel'
import { levelName } from '../../../utils/floors'

/**
 * A hotel's floors (§25): level, label, rooms in inventory today, status. Add one, add many, edit, deactivate (tier
 * 1: hidden from room forms, history kept) or activate — all with `room.manage`, and not while the hotel is inactive.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const notify = useNotify()
const hotelRefresh = useHotelRefresh()
const access = useAccess()
const { hotel, hotelId, ready, isInactive } = useCurrentHotel()
const includeInactive = ref(false)

const floors = useApiQuery(() => ['floors', hotelId.value, includeInactive.value], () => api<FloorListItem[]>(`/hotels/${hotelId.value}/floors`, { query: { includeInactive: String(includeInactive.value) } }), { enabled: ready })
const canManage = computed(() => ready.value && access.value.canInHotel('room.manage', hotelId.value))

const drawer = ref<'one' | 'many' | null>(null)
const editing = ref<FloorListItem | null>(null)
const openOne = (floor: FloorListItem | null) => {
  editing.value = floor
  drawer.value = 'one'
}
async function saved(message: string): Promise<void> {
  notify.done(message)
  await hotelRefresh(hotelId.value)
}

const deactivating = ref<FloorListItem | null>(null)
const setActive = useMutation({
  mutationFn: ({ floor, active }: { floor: FloorListItem, active: boolean }) => api<FloorListItem>(`/hotels/${hotelId.value}/floors/${floor.id}/${active ? 'activate' : 'deactivate'}`, { method: 'POST' }),
  onSuccess: async (floor) => {
    deactivating.value = null
    await saved(floor.isActive ? t('floors.activated', { label: floor.label }) : t('floors.deactivated', { label: floor.label }))
  },
  onError: (error) => {
    deactivating.value = null
    notify.failed(error)
  },
})
</script>

<template>
  <HotelFrame tab="floors" :title="t('hotel.tab.floors')">
    <template #actions>
      <template v-if="canManage">
        <UTooltip :text="isInactive ? t('hotel.inactiveReason') : undefined" :disabled="!isInactive">
          <UButton icon="i-lucide-layers" :disabled="isInactive" @click="drawer = 'many'">{{ t('floors.addMany') }}</UButton>
        </UTooltip>
        <UButton color="neutral" variant="outline" icon="i-lucide-plus" :disabled="isInactive" @click="openOne(null)">{{ t('floors.addOne') }}</UButton>
      </template>
    </template>

    <USwitch v-model="includeInactive" :label="t('floors.includeInactive')" />
    <ErrorState v-if="floors.error.value" :error="floors.error.value" @retry="floors.refetch()" />
    <div v-else-if="floors.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 5" :key="n" class="h-12" /></div>
    <EmptyState v-else-if="!floors.data.value?.length" :title="t('floors.none')" icon="i-lucide-layers">
      <UButton v-if="canManage && !isInactive" icon="i-lucide-layers" @click="drawer = 'many'">{{ t('floors.addMany') }}</UButton>
    </EmptyState>
    <div v-else class="surface-panel overflow-x-auto">
      <table class="w-full">
        <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
          <tr>
            <th scope="col" class="px-4 py-2 text-start">{{ t('floors.level') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('floors.label') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('floors.rooms') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('floors.status') }}</th>
            <th v-if="canManage" scope="col" class="px-4 py-2"><span class="sr-only">{{ t('common.actions') }}</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--border)">
          <tr v-for="floor in floors.data.value" :key="floor.id" :class="{ 'text-(--fg-muted)': !floor.isActive }">
            <td class="px-4 py-3 tabular">{{ levelName(floor.level, t) }}</td>
            <td class="px-4 py-3"><bdi>{{ floor.label }}</bdi></td>
            <td class="px-4 py-3 text-end tabular">{{ floor.roomCount }}</td>
            <td class="px-4 py-3"><UBadge :color="floor.isActive ? 'success' : 'neutral'" variant="soft" :icon="floor.isActive ? 'i-lucide-circle-check' : 'i-lucide-circle-pause'">{{ floor.isActive ? t('floors.active') : t('floors.inactive') }}</UBadge></td>
            <td v-if="canManage" class="px-4 py-3 text-end">
              <div class="flex justify-end gap-1">
                <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-pencil" :disabled="isInactive" :aria-label="t('floors.editNamed', { label: floor.label })" @click="openOne(floor)" />
                <UButton v-if="floor.isActive" size="sm" color="neutral" variant="ghost" :disabled="isInactive" :aria-label="t('floors.deactivateNamed', { label: floor.label })" @click="deactivating = floor">{{ t('floors.deactivate') }}</UButton>
                <UButton v-else size="sm" color="neutral" variant="ghost" :disabled="isInactive" :loading="setActive.isPending.value" :aria-label="t('floors.activateNamed', { label: floor.label })" @click="setActive.mutate({ floor, active: true })">{{ t('floors.activate') }}</UButton>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <template v-if="hotel">
      <FloorDrawer :open="drawer === 'one'" :hotel="hotel" :floor="editing" @update:open="value => { if (!value) drawer = null }" @saved="floor => saved(t('floors.saved', { label: floor.label }))" />
      <BulkFloorsDrawer :open="drawer === 'many'" :hotel="hotel" @update:open="value => { if (!value) drawer = null }" @saved="created => saved(t('floors.created', created.length))" />
      <ConfirmDialog
        :open="!!deactivating"
        :title="t('floors.deactivateTitle', { label: deactivating?.label ?? '' })"
        :description="t('floors.deactivateText', { label: deactivating?.label ?? '', hotel: hotel.name })"
        :confirm-label="t('floors.deactivateNamed', { label: deactivating?.label ?? '' })"
        :pending="setActive.isPending.value"
        @update:open="value => { if (!value) deactivating = null }"
        @confirm="deactivating && setActive.mutate({ floor: deactivating, active: false })"
      />
    </template>
  </HotelFrame>
</template>
