<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { cancelBookingSchema } from '@hajj/contracts/schemas/booking'
import type { BookingDetailDto } from '@hajj/contracts/types/booking'
import { heldWhile } from '../../utils/forms'

/** Cancel a booking (v7 §12, tier 2): with the reason, kept on the booking; its pilgrims lose their places. */
const props = defineProps<{ booking: BookingDetailDto }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ done: [BookingDetailDto] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()

const form = ref({ reason: '' })
const validate = validateWith(cancelBookingSchema, key => t(key))
const cancel = useMutation({
  mutationFn: () => api<BookingDetailDto>(`/bookings/${props.booking.id}/cancel`, { method: 'POST', body: cancelBookingSchema.parse(form.value) }),
  onSuccess: (cancelled) => {
    open.value = false
    emit('done', cancelled)
  },
})
watch(open, (isOpen) => {
  if (!isOpen) return
  form.value = { reason: '' }
  cancel.reset()
})
</script>

<template>
  <UModal
    v-bind="heldWhile(cancel.isPending.value)"
    v-model:open="open"
    :title="t('bookings.cancelTitle', { no: booking.bookingNo })"
    :description="t('bookings.cancelText', { count: booking.guests.total }, booking.guests.total)"
  >
    <template #body>
      <UForm :state="form" :validate="validate" class="flex flex-col gap-4" @submit="cancel.mutate()">
        <UFormField :label="t('bookings.cancelReason')" :help="t('bookings.cancelReasonHelp')" name="reason" required>
          <UTextarea v-model="form.reason" :rows="3" :maxlength="500" autofocus class="w-full" />
        </UFormField>
        <UAlert v-if="cancel.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(cancel.error.value)" role="alert" />
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" :disabled="cancel.isPending.value" @click="open = false">{{ t('bookings.keep') }}</UButton>
          <UButton type="submit" color="error" :loading="cancel.isPending.value">{{ t('bookings.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </UModal>
</template>
