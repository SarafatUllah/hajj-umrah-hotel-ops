<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { createHotelSchema } from '@hajj/contracts/schemas/hotel'
import type { HotelDetail } from '@hajj/contracts/types/hotel'
import type { FormRef } from '../../utils/forms'
import { createRequestOf, emptyHotelForm } from '../../utils/hotelForm'

/**
 * A new hotel (§24): one page, three sections. Only for `hotel.manage` with all hotels (the API refuses others). A
 * duplicate code is pointed out on the code field. The new hotel opens on its overview, with its setup checklist.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const notify = useNotify()
const errorMessage = useErrorMessage()
const queryClient = useQueryClient()
const access = useAccess()
useSeoMeta({ title: () => t('hotels.new') })

const allowed = computed(() => access.value.can('hotel.manage') && access.value.hasAllHotels)
const form = ref(emptyHotelForm())
const validate = validateWith(createHotelSchema, key => t(key), createRequestOf)
const formRef = ref<FormRef | null>(null)
const codeTaken = ref(false)
const create = useMutation({
  mutationFn: () => api<HotelDetail>('/hotels', { method: 'POST', body: createRequestOf(form.value) }),
  onSuccess: async (hotel) => {
    await queryClient.invalidateQueries({ queryKey: ['hotels'] })
    await queryClient.invalidateQueries({ queryKey: ['capacity-averages'] })
    notify.done(t('hotels.created', { name: hotel.name }))
    await navigateTo(`/hotels/${encodeURIComponent(hotel.code)}`)
  },
  // A code already used is the code field's problem (§24), not a banner.
  onError: (error) => {
    codeTaken.value = toApiError(error).code === 'ALREADY_EXISTS'
    if (codeTaken.value) formRef.value?.setErrors([{ name: 'code', message: t('hotel.codeTaken') }], 'code')
  },
})
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-6">
    <PageHeader :title="t('hotels.new')" :description="t('hotels.newHelp')" />
    <EmptyState v-if="!allowed" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <UForm v-else ref="formRef" :state="form" :validate="validate" class="surface-panel flex flex-col gap-6 p-6" @submit="create.mutate()">
      <HotelDetailsFields v-model="form" mode="create" :disabled="create.isPending.value" />
      <UAlert v-if="create.error.value && !codeTaken" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(create.error.value)" role="alert" />
      <div class="sticky bottom-0 -mx-6 -mb-6 flex gap-2 border-t border-(--border) bg-(--surface-1) px-6 py-4">
        <UButton type="submit" :loading="create.isPending.value">{{ t('hotels.create') }}</UButton>
        <UButton to="/hotels" color="neutral" variant="ghost">{{ t('common.cancel') }}</UButton>
      </div>
    </UForm>
  </div>
</template>
