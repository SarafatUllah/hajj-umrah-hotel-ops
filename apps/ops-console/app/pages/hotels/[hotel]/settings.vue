<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { type ResolvedSettings, updateSettingsSchema } from '@hajj/contracts/business-rules/hotelSettings'
import { updateHotelSchema } from '@hajj/contracts/schemas/hotel'
import type { HotelDetail } from '@hajj/contracts/types/hotel'
import { type HotelForm, hotelFormOf, updateRequestOf } from '../../../utils/hotelForm'

/**
 * A hotel's Settings tab (§24): three panels saved apart — its details (the code locked), its inventory rules, and
 * its status (deactivate: tier 2; reactivate). Without `hotel.manage` the values show, read-only.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const notify = useNotify()
const errorMessage = useErrorMessage()
const hotelRefresh = useHotelRefresh()
const access = useAccess()
const { hotel, hotelId, ready } = useCurrentHotel()
const canManage = computed(() => ready.value && access.value.canInHotel('hotel.manage', hotelId.value))
// Every panel's save changes what the hotel's other pages show (figures, history): all of it is asked again.
const refreshHotel = () => hotelRefresh(hotelId.value)

// 1. Details.
const detail = useApiQuery(() => ['hotel', hotelId.value], () => api<HotelDetail>(`/hotels/${hotelId.value}`), { enabled: ready })
// A refetch (back to the tab) refreshes the form only while nothing is being edited: unsaved changes stay.
const { form, changes, changesFrom, load } = useEditForm(() => detail.data.value, hotelFormOf, updateRequestOf)
const validateDetails = validateWith(updateHotelSchema, key => t(key), (state: HotelForm) => changesFrom(state))
const saveDetails = useMutation({
  mutationFn: () => api<HotelDetail>(`/hotels/${hotelId.value}`, { method: 'PATCH', body: changes.value }),
  onSuccess: async (updated) => {
    load(updated)
    notify.done(t('settings.detailsSaved'))
    await refreshHotel()
  },
})

// 2. Inventory rules.
const settings = useApiQuery(() => ['hotel-settings', hotelId.value], () => api<ResolvedSettings>(`/hotels/${hotelId.value}/settings`), { enabled: ready })
const rules = ref({ maintenanceBlocksSales: true, defaultRangeDays: 31 })
watch(() => settings.data.value, (loaded) => {
  if (loaded) rules.value = { maintenanceBlocksSales: loaded['inventory.maintenanceBlocksSales'], defaultRangeDays: loaded['calendar.defaultRangeDays'] }
}, { immediate: true })
const rulesRequest = (state: typeof rules.value) => ({ 'inventory.maintenanceBlocksSales': state.maintenanceBlocksSales, 'calendar.defaultRangeDays': state.defaultRangeDays })
const validateRules = validateWith(updateSettingsSchema, key => t(key), rulesRequest)
const saveRules = useMutation({
  mutationFn: () => api<ResolvedSettings>(`/hotels/${hotelId.value}/settings`, { method: 'PUT', body: rulesRequest(rules.value) }),
  onSuccess: async () => {
    notify.done(t('settings.rulesSaved'))
    await refreshHotel()
  },
})
/** Bookings on maintenance nights stop sales from being stopped there (409 BOOKING_CONFLICT): named, to move them first. */
const conflictingBookings = computed(() => (saveRules.error.value ? [...new Set((toApiError(saveRules.error.value).detail<Array<{ bookingNo: string }>>('bookings') ?? []).map(b => b.bookingNo))] : []))

// 3. Status.
const deactivating = ref(false)
const setStatus = useMutation({
  mutationFn: (active: boolean) => api<HotelDetail>(`/hotels/${hotelId.value}/${active ? 'activate' : 'deactivate'}`, { method: 'POST' }),
  onSuccess: async (updated) => {
    deactivating.value = false
    notify.done(updated.status === 'ACTIVE' ? t('settings.reactivated', { name: updated.name }) : t('settings.deactivated', { name: updated.name }))
    await refreshHotel()
  },
  onError: (error) => {
    deactivating.value = false
    notify.failed(error)
  },
})
</script>

<template>
  <HotelFrame tab="settings" :title="t('hotel.tab.settings')">
    <p v-if="!canManage" class="flex items-center gap-2 text-(--fg-muted)"><UIcon name="i-lucide-lock" class="size-4" />{{ t('settings.readOnly') }}</p>

    <section aria-labelledby="details-heading" class="surface-panel flex max-w-3xl flex-col gap-4 p-6">
      <h2 id="details-heading" class="text-section">{{ t('settings.details') }}</h2>
      <ErrorState v-if="detail.error.value" :error="detail.error.value" @retry="detail.refetch()" />
      <USkeleton v-else-if="!form" class="h-64" />
      <UForm v-else :state="form" :validate="validateDetails" class="flex flex-col gap-6" @submit="saveDetails.mutate()">
        <HotelDetailsFields v-model="form" mode="edit" :disabled="!canManage || saveDetails.isPending.value" />
        <UAlert v-if="saveDetails.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(saveDetails.error.value)" role="alert" />
        <UButton v-if="canManage" type="submit" :loading="saveDetails.isPending.value" class="self-start">{{ t('settings.saveDetails') }}</UButton>
      </UForm>
    </section>

    <section aria-labelledby="rules-heading" class="surface-panel flex max-w-3xl flex-col gap-4 p-6">
      <h2 id="rules-heading" class="text-section">{{ t('settings.rules') }}</h2>
      <ErrorState v-if="settings.error.value" :error="settings.error.value" @retry="settings.refetch()" />
      <USkeleton v-else-if="!settings.data.value" class="h-24" />
      <UForm v-else :state="rules" :validate="validateRules" class="flex flex-col gap-4" @submit="saveRules.mutate()">
        <UFormField name="inventory.maintenanceBlocksSales" :help="t('settings.maintenanceHelp')">
          <USwitch v-model="rules.maintenanceBlocksSales" :label="t('settings.maintenanceBlocksSales')" :disabled="!canManage" />
        </UFormField>
        <UFormField :label="t('settings.defaultRange')" :help="t('settings.defaultRangeHelp')" name="calendar.defaultRangeDays">
          <UInputNumber v-model="rules.defaultRangeDays" :min="7" :max="400" :disabled="!canManage" class="w-36" />
        </UFormField>
        <UAlert v-if="conflictingBookings.length" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(saveRules.error.value)" :description="t('settings.conflictingBookings', { list: conflictingBookings.join(', ') })" role="alert" />
        <UAlert v-else-if="saveRules.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(saveRules.error.value)" role="alert" />
        <UButton v-if="canManage" type="submit" :loading="saveRules.isPending.value" class="self-start">{{ t('settings.saveRules') }}</UButton>
      </UForm>
    </section>

    <section v-if="canManage && hotel" aria-labelledby="status-heading" class="flex max-w-3xl flex-col gap-3 rounded-lg border border-(--border-strong) p-6">
      <h2 id="status-heading" class="text-section">{{ t('settings.status') }}</h2>
      <template v-if="hotel.status === 'ACTIVE'">
        <p class="text-(--fg-muted)">{{ t('settings.deactivateHelp') }}</p>
        <UButton color="error" variant="outline" icon="i-lucide-circle-pause" class="self-start" @click="deactivating = true">{{ t('settings.deactivate') }}</UButton>
      </template>
      <template v-else>
        <p class="text-(--fg-muted)">{{ t('settings.reactivateHelp') }}</p>
        <UButton icon="i-lucide-circle-play" :loading="setStatus.isPending.value" class="self-start" @click="setStatus.mutate(true)">{{ t('settings.reactivate') }}</UButton>
      </template>
      <ConfirmDialog
        v-model:open="deactivating"
        :tier="2"
        destructive
        :title="t('settings.deactivateTitle', { name: hotel.name })"
        :description="t('settings.deactivateText', { name: hotel.name })"
        :confirm-label="t('settings.deactivateNamed', { name: hotel.name })"
        :pending="setStatus.isPending.value"
        @confirm="setStatus.mutate(false)"
      />
    </section>
  </HotelFrame>
</template>
