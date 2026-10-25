<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import type { RoomTypeListItem } from '@hajj/contracts/types/hotel'

/**
 * The organization's room types (§26): shared by all hotels. Everyone with `room.view` reads them; adding, editing
 * and deactivating need `room.manage` with all hotels — a hotel's own manager sees why not. "Rooms using it" only for
 * those who see every hotel.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const notify = useNotify()
const queryClient = useQueryClient()
const access = useAccess()
const { me } = useStaffSession()
useSeoMeta({ title: () => t('roomTypes.title') })
const includeInactive = ref(false)
const types = useApiQuery(() => ['room-types', includeInactive.value], () => api<RoomTypeListItem[]>('/room-types', { query: { includeInactive: String(includeInactive.value) } }))
const canManage = computed(() => access.value.can('room.manage') && access.value.hasAllHotels)
const showUsage = computed(() => access.value.hasAllHotels)
const refresh = () => queryClient.invalidateQueries({ queryKey: ['room-types'] })

const drawerOpen = ref(false)
const editing = ref<RoomTypeListItem | null>(null)
function openDrawer(type: RoomTypeListItem | null): void {
  editing.value = type
  drawerOpen.value = true
}
async function saved(type: RoomTypeListItem, changedDefaults: boolean): Promise<void> {
  notify.done(changedDefaults ? t('roomTypes.defaultsSaved', { name: type.name }) : t('roomTypes.saved', { name: type.name }))
  await refresh()
}
const deactivating = ref<RoomTypeListItem | null>(null)
const setActive = useMutation({
  mutationFn: ({ type, active }: { type: RoomTypeListItem, active: boolean }) => api<RoomTypeListItem>(`/room-types/${type.id}/${active ? 'activate' : 'deactivate'}`, { method: 'POST' }),
  onSuccess: async (type) => {
    deactivating.value = null
    notify.done(type.isActive ? t('roomTypes.activated', { name: type.name }) : t('roomTypes.deactivated', { name: type.name }))
    await refresh()
  },
  onError: (error) => {
    deactivating.value = null
    notify.failed(error)
  },
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="t('roomTypes.title')" :description="t('roomTypes.subtitle', { organization: me?.organization.name ?? '' })">
      <template #actions>
        <UButton v-if="canManage" icon="i-lucide-plus" @click="openDrawer(null)">{{ t('roomTypes.add') }}</UButton>
      </template>
    </PageHeader>
    <p v-if="!canManage && access.can('room.manage')" class="flex items-center gap-2 text-(--fg-muted)"><UIcon name="i-lucide-lock" class="size-4" />{{ t('roomTypes.askAdmin') }}</p>
    <USwitch v-model="includeInactive" :label="t('roomTypes.includeInactive')" />
    <ErrorState v-if="types.error.value" :error="types.error.value" @retry="types.refetch()" />
    <div v-else-if="types.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 4" :key="n" class="h-12" /></div>
    <EmptyState v-else-if="!types.data.value?.length" :title="t('roomTypes.none')" icon="i-lucide-bed-double">
      <UButton v-if="canManage" icon="i-lucide-plus" @click="openDrawer(null)">{{ t('roomTypes.add') }}</UButton>
    </EmptyState>
    <div v-else class="surface-panel overflow-x-auto">
      <table class="w-full">
        <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
          <tr>
            <th scope="col" class="px-4 py-2 text-start">{{ t('roomTypes.name') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('roomTypes.code') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('roomTypes.beds') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('roomTypes.haji') }}</th>
            <th v-if="showUsage" scope="col" class="px-4 py-2 text-end">{{ t('roomTypes.usage') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('floors.status') }}</th>
            <th v-if="canManage" scope="col" class="px-4 py-2"><span class="sr-only">{{ t('common.actions') }}</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--border)">
          <tr v-for="type in types.data.value" :key="type.id" :class="{ 'text-(--fg-muted)': !type.isActive }">
            <td class="px-4 py-3 font-medium"><bdi>{{ type.name }}</bdi></td>
            <td class="px-4 py-3" dir="ltr">{{ type.code }}</td>
            <td class="px-4 py-3 text-end tabular">{{ type.defaultPhysicalBeds }}</td>
            <td class="px-4 py-3 text-end tabular">{{ type.defaultSellableCapacity }}</td>
            <td v-if="showUsage" class="px-4 py-3 text-end tabular">{{ type.usageCount ?? '—' }}</td>
            <td class="px-4 py-3"><UBadge :color="type.isActive ? 'success' : 'neutral'" variant="soft">{{ type.isActive ? t('floors.active') : t('floors.inactive') }}</UBadge></td>
            <td v-if="canManage" class="px-4 py-3 text-end">
              <div class="flex justify-end gap-1">
                <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="t('roomTypes.edit', { name: type.name })" @click="openDrawer(type)" />
                <UButton v-if="type.isActive" size="sm" color="neutral" variant="ghost" :aria-label="t('roomTypes.deactivateNamed', { name: type.name })" @click="deactivating = type">{{ t('floors.deactivate') }}</UButton>
                <UButton v-else size="sm" color="neutral" variant="ghost" :loading="setActive.isPending.value" :aria-label="t('roomTypes.activateNamed', { name: type.name })" @click="setActive.mutate({ type, active: true })">{{ t('floors.activate') }}</UButton>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <RoomTypeDrawer v-model:open="drawerOpen" :room-type="editing" @saved="saved" />
    <ConfirmDialog
      :open="!!deactivating"
      :title="t('roomTypes.deactivateTitle', { name: deactivating?.name ?? '' })"
      :description="deactivating?.usageCount !== null && deactivating?.usageCount !== undefined ? t('roomTypes.deactivateUsage', { name: deactivating.name, count: deactivating.usageCount }) : t('roomTypes.deactivateText', { name: deactivating?.name ?? '' })"
      :confirm-label="t('roomTypes.deactivateNamed', { name: deactivating?.name ?? '' })"
      :pending="setActive.isPending.value"
      @update:open="value => { if (!value) deactivating = null }"
      @confirm="deactivating && setActive.mutate({ type: deactivating, active: false })"
    />
  </div>
</template>
