<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { dateChangeSearchSchema } from '@hajj/contracts/schemas/booking'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { BookingDetailDto, StaySearchResult } from '@hajj/contracts/types/booking'
import { heldWhile } from '../../utils/forms'

/**
 * Change a booking's dates (v7 §12): the new nights, the rooms found there for all its pilgrims (priced per night
 * again), then the move — all or nothing: when the rooms went meanwhile, nothing changes and the search starts over.
 */
const props = defineProps<{ booking: BookingDetailDto, hotel: HotelSummary }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ done: [BookingDetailDto] }>()
const { t } = useI18n()
const api = useApi()
const format = useFormat()
const errorMessage = useErrorMessage()

const dates = ref({ checkIn: '', checkOut: '' })
const validate = validateWith(dateChangeSearchSchema, key => t(key))
const { result, chosen, option, found, failed, question } = useStayOptions(dates)
const search = useMutation({
  mutationFn: (_asked: number) => api<StaySearchResult>(`/bookings/${props.booking.id}/dates/search`, { method: 'POST', body: dates.value }),
  onSuccess: (answer, asked) => {
    apply.reset()
    found(answer, null, asked)
  },
})
const apply = useMutation({
  mutationFn: () => api<BookingDetailDto>(`/bookings/${props.booking.id}/dates`, { method: 'POST', body: { ...dates.value, rooms: chosenRoomsOf(option.value!) } }),
  onSuccess: (moved) => {
    open.value = false
    emit('done', moved)
  },
  onError: failed,
})
watch(open, (isOpen) => {
  if (!isOpen) return
  dates.value = { checkIn: props.booking.checkIn, checkOut: props.booking.checkOut }
  search.reset()
  apply.reset()
})
const pending = computed(() => search.isPending.value || apply.isPending.value)
</script>

<template>
  <USlideover v-bind="heldWhile(pending)" v-model:open="open" :title="t('bookings.changeDates')" :description="t('bookings.changeDatesHelp')" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="flex flex-col gap-5">
        <HotelStamp :hotel="hotel" />
        <p class="text-(--fg-muted)">{{ t('bookings.datesNow', { stay: format.stay(booking.checkIn, booking.checkOut) }) }}</p>
        <UForm :state="dates" :validate="validate" class="flex flex-col gap-4" @submit="search.mutate(question())">
          <div class="grid grid-cols-2 gap-4">
            <UFormField :label="t('stay.checkIn')" name="checkIn" required><UInput v-model="dates.checkIn" type="date" :min="hotel.today" dir="ltr" class="w-full" /></UFormField>
            <UFormField :label="t('stay.checkOut')" name="checkOut" required><UInput v-model="dates.checkOut" type="date" :min="dates.checkIn || hotel.today" dir="ltr" class="w-full" /></UFormField>
          </div>
          <UAlert v-if="search.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(search.error.value)" role="alert" />
          <UAlert v-if="apply.error.value && !result" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(apply.error.value)" role="alert" />
          <UButton type="submit" color="neutral" variant="outline" icon="i-lucide-search" :loading="search.isPending.value" class="self-start">{{ t('stay.search') }}</UButton>
        </UForm>
        <section v-if="result" class="flex flex-col gap-3" aria-live="polite">
          <EmptyState v-if="!result.options.length" :title="t('stay.noOptions')" icon="i-lucide-bed-double" />
          <template v-for="(candidate, index) in result.options" :key="index">
            <OptionCard v-if="chosen === null || chosen === index" :option="candidate" :index="index" :selected="chosen === index" @choose="chosen = index" />
          </template>
          <UAlert v-if="apply.error.value && result" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(apply.error.value)" role="alert" />
          <div v-if="chosen !== null" class="flex flex-wrap gap-2">
            <UButton icon="i-lucide-calendar-check" :loading="apply.isPending.value" @click="apply.mutate()">{{ t('bookings.applyDates') }}</UButton>
            <UButton color="neutral" variant="ghost" :disabled="apply.isPending.value" @click="chosen = null">{{ t('stay.changeOption') }}</UButton>
          </div>
        </section>
      </div>
    </template>
  </USlideover>
</template>
