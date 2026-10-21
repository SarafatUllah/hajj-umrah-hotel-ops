<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { BOOKING_TYPES } from '@hajj/contracts/constants/booking'
import { staffQuoteCreateSchema } from '@hajj/contracts/schemas/quote'
import type { RequestedQuote } from '@hajj/contracts/types/quote'
import { heldWhile } from '../../utils/forms'

/**
 * Open a quote on an agency's behalf (v7 §8: the WhatsApp talk started elsewhere): the agency, the hotel, the stay,
 * who comes (a group's men and women, a family's total) and notes. It opens REQUESTED, with the WhatsApp link to the
 * hotel's number when one is set — then its price is set from the list.
 */
const props = defineProps<{ hotels: Array<{ value: string, label: string }>, agencies: Array<{ value: string, label: string }>, hotelId?: string }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [RequestedQuote] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()

/** The hotel to start with: the switcher's where this user may quote, else the only one they may. */
function startingHotel(): string {
  if (props.hotelId && props.hotels.some(h => h.value === props.hotelId)) return props.hotelId
  return props.hotels.length === 1 ? props.hotels[0]!.value : ''
}
const blank = () => ({ agencyId: '', hotelId: startingHotel(), bookingType: 'GROUP' as typeof BOOKING_TYPES[number], checkIn: '', checkOut: '', maleCount: 0 as number | null, femaleCount: 0 as number | null, totalCount: 1 as number | null, notes: '' })
const form = ref(blank())
// A group's cleared count is none of that side; a family gives only its total.
function request(state: typeof form.value) {
  const notes = state.notes.trim() || undefined
  if (state.bookingType !== 'GROUP') return { ...state, maleCount: 0, femaleCount: 0, notes }
  const maleCount = state.maleCount ?? 0
  const femaleCount = state.femaleCount ?? 0
  return { ...state, maleCount, femaleCount, totalCount: maleCount + femaleCount, notes }
}
const validate = validateWith(staffQuoteCreateSchema, key => t(key), request)
const created = ref<RequestedQuote | null>(null)
const create = useMutation({
  mutationFn: () => api<RequestedQuote>('/quotes', { method: 'POST', body: request(form.value) }),
  onSuccess: (answer) => {
    created.value = answer
    emit('created', answer)
  },
})
watch(open, (isOpen) => {
  if (!isOpen) return
  form.value = blank()
  created.value = null
  create.reset()
})
const types = computed(() => BOOKING_TYPES.map(value => ({ value, label: t(`booking.type.${value}`) })))
</script>

<template>
  <USlideover v-bind="heldWhile(create.isPending.value)" v-model:open="open" :title="t('quotes.new')" :description="t('quotes.newHelp')">
    <template #body>
      <div v-if="created" class="flex flex-col gap-4" role="status">
        <p>{{ t('quotes.created', { ref: created.quote.refNo }) }}</p>
        <UButton v-if="created.whatsappLink" :to="created.whatsappLink" target="_blank" rel="noopener" icon="i-lucide-message-circle" class="self-start">{{ t('quotes.openWhatsapp') }}</UButton>
        <UButton color="neutral" variant="outline" class="self-start" @click="open = false">{{ t('quotes.done') }}</UButton>
      </div>
      <UForm v-else :state="form" :validate="validate" class="flex flex-col gap-4" @submit="create.mutate()">
        <UFormField :label="t('newBooking.agency')" name="agencyId" required>
          <USelectMenu v-model="form.agencyId" :items="agencies" value-key="value" :placeholder="t('newBooking.chooseAgency')" class="w-full" />
        </UFormField>
        <UFormField :label="t('stay.hotel')" name="hotelId" required><USelect v-model="form.hotelId" :items="hotels" class="w-full" /></UFormField>
        <div class="grid grid-cols-2 gap-4">
          <UFormField :label="t('stay.checkIn')" name="checkIn" required><UInput v-model="form.checkIn" type="date" dir="ltr" class="w-full" /></UFormField>
          <UFormField :label="t('stay.checkOut')" name="checkOut" required><UInput v-model="form.checkOut" type="date" :min="form.checkIn || undefined" dir="ltr" class="w-full" /></UFormField>
        </div>
        <UFormField :label="t('stay.type')" name="bookingType"><URadioGroup v-model="form.bookingType" :items="types" orientation="horizontal" /></UFormField>
        <div v-if="form.bookingType === 'GROUP'" class="grid grid-cols-2 gap-4">
          <UFormField :label="t('stay.men')" name="maleCount"><UInputNumber v-model="form.maleCount" :min="0" :max="10000" class="w-full" /></UFormField>
          <UFormField :label="t('stay.women')" name="femaleCount"><UInputNumber v-model="form.femaleCount" :min="0" :max="10000" class="w-full" /></UFormField>
        </div>
        <UFormField v-else :label="t('stay.total')" name="totalCount"><UInputNumber v-model="form.totalCount" :min="1" :max="10000" class="w-full" /></UFormField>
        <UFormField :label="t('bookings.notes')" :hint="t('common.optional')" name="notes"><UTextarea v-model="form.notes" :rows="2" :maxlength="1000" class="w-full" /></UFormField>
        <UAlert v-if="create.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(create.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="create.isPending.value">{{ t('quotes.create') }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="create.isPending.value" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
