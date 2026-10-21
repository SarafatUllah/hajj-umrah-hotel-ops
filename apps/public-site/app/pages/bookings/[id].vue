<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { CONFIRMED_BOOKING_STATUSES } from '@hajj/contracts/constants/booking'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import type { BookingDetailDto, GuestSlotDto, ReceiptDto } from '@hajj/contracts/types/booking'

definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const route = useRoute()
const api = useApi()
const notify = useNotify()
const errorMessage = useErrorMessage()
const queryClient = useQueryClient()
const id = computed(() => String(route.params.id))

const booking = useApiQuery(() => ['customer-booking', id.value], () => api<BookingDetailDto>(`/customer/bookings/${id.value}`))
const guests = useApiQuery(() => ['customer-guests', id.value], () => api<GuestSlotDto[]>(`/customer/bookings/${id.value}/guests`))
const { data: hotels } = usePublicHotels()
const confirmed = computed(() => (CONFIRMED_BOOKING_STATUSES as readonly string[]).includes(booking.data.value?.status ?? ''))
const receipt = useApiQuery(() => ['customer-receipt', id.value], () => api<ReceiptDto>(`/customer/bookings/${id.value}/receipt`), { enabled: confirmed })
const hotelName = computed(() => hotels.value?.find(h => h.id === booking.data.value?.hotelId)?.name ?? receipt.data.value?.hotel.name ?? '')
useSeoMeta({ title: () => (booking.data.value ? t('bookings.number', { no: booking.data.value.bookingNo }) : t('bookings.title')), robots: 'noindex' })

const refresh = () => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['customer-booking', id.value] }),
  queryClient.invalidateQueries({ queryKey: ['customer-guests', id.value] }),
  queryClient.invalidateQueries({ queryKey: ['customer-bookings'] }),
])

const printReceipt = () => window.print()

// Withdraw an open request (tier 1).
const withdrawOpen = ref(false)
const withdraw = useMutation({
  mutationFn: () => api<BookingDetailDto>(`/customer/bookings/${id.value}/withdraw`, { method: 'POST' }),
  onSuccess: async () => {
    withdrawOpen.value = false
    notify.done(t('bookings.withdrawn'))
    await refresh()
  },
  onError: (error) => {
    withdrawOpen.value = false
    notify.failed(error)
  },
})

// Fill in a pilgrim's details (a slot still waiting for them).
const editing = ref<GuestSlotDto | null>(null)
const details = ref<GuestFieldValues>({ fullName: '' })
function openDetails(slot: GuestSlotDto) {
  editing.value = slot
  details.value = { fullName: slot.details?.fullName ?? '', gender: slot.gender ?? undefined, nationality: slot.details?.nationality ?? undefined }
}
const validateDetails = validateWith(guestDetailsSchema, key => t(key))
const saveDetails = useMutation({
  mutationFn: () => api<GuestSlotDto>(`/customer/bookings/${id.value}/guests/${editing.value!.id}`, { method: 'PUT', body: guestDetailsSchema.parse(details.value) }),
  onSuccess: async () => {
    editing.value = null
    notify.done(t('guest.saved'))
    await refresh()
  },
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <ErrorState v-if="booking.error.value" :error="booking.error.value" @retry="booking.refetch()" />
    <USkeleton v-else-if="booking.isPending.value" class="h-48" />
    <template v-else-if="booking.data.value">
      <PageHeader :title="t('bookings.number', { no: booking.data.value.bookingNo })" :description="hotelName">
        <template #actions>
          <StatusBadge domain="booking" :value="booking.data.value.status" />
          <UButton v-if="booking.data.value.status === 'REQUESTED'" color="neutral" variant="outline" icon="i-lucide-undo-2" @click="withdrawOpen = true">
            {{ t('bookings.withdraw') }}
          </UButton>
        </template>
      </PageHeader>

      <UAlert v-if="booking.data.value.status === 'REQUESTED'" color="info" variant="soft" icon="i-lucide-hourglass" :title="t('bookings.requestedNote')" />

      <dl class="surface-panel grid gap-4 p-5 sm:grid-cols-3">
        <div>
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.stay') }}</dt>
          <dd><StayDates :check-in="booking.data.value.checkIn" :check-out="booking.data.value.checkOut" /></dd>
        </div>
        <div>
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.rooms') }}</dt>
          <dd class="tabular">{{ booking.data.value.rooms.filter(r => r.status !== 'RELEASED').map(r => r.roomNumber).join(', ') }}</dd>
        </div>
        <div>
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.price') }}</dt>
          <dd><MoneyText :halalas="booking.data.value.totalHalalas" /> · {{ t(`booking.priceSource.${booking.data.value.priceSource}`) }}</dd>
        </div>
      </dl>

      <section aria-labelledby="pilgrims-heading" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="pilgrims-heading" class="text-section">{{ t('bookings.pilgrims') }}</h2>
          <span class="text-(--fg-muted)">{{ t('bookings.detailsProgress', { done: booking.data.value.guests.withDetails, total: booking.data.value.guests.total }) }}</span>
        </div>
        <ErrorState v-if="guests.error.value" :error="guests.error.value" @retry="guests.refetch()" />
        <ul v-else class="surface-panel divide-y divide-(--border)">
          <li v-for="slot in guests.data.value ?? []" :key="slot.id" class="flex flex-wrap items-center justify-between gap-3 p-4">
            <div class="flex flex-col gap-1">
              <span class="text-caption text-(--fg-muted)">{{ slotLabel(slot, t) }}</span>
              <span><bdi>{{ slot.details?.fullName ?? '—' }}</bdi> <span v-if="slot.details?.passportNo" class="tabular text-(--fg-muted)" dir="ltr">{{ slot.details.passportNo }}</span></span>
            </div>
            <div class="flex items-center gap-2">
              <StatusBadge domain="guest" :value="slot.status" />
              <UButton v-if="slot.status === 'PENDING_DETAILS'" size="sm" color="neutral" variant="outline" icon="i-lucide-file-pen" @click="openDetails(slot)">{{ t('guest.addDetails') }}</UButton>
            </div>
          </li>
        </ul>
        <p class="text-small text-(--fg-muted)">{{ t('bookings.askHotel') }}</p>
      </section>

      <section v-if="receipt.data.value" aria-labelledby="receipt-heading" class="surface-panel flex flex-col items-center gap-4 p-6">
        <h2 id="receipt-heading" class="text-section self-start">{{ t('receipt.title') }}</h2>
        <ReceiptQr :token="receipt.data.value.qrToken" :booking-no="receipt.data.value.bookingNo" />
        <UButton color="neutral" variant="outline" icon="i-lucide-printer" class="print:hidden" @click="printReceipt">{{ t('receipt.print') }}</UButton>
      </section>

      <ConfirmDialog
        v-model:open="withdrawOpen"
        :title="t('bookings.withdrawTitle')"
        :description="t('bookings.withdrawText', { no: booking.data.value.bookingNo })"
        :confirm-label="t('bookings.withdraw')"
        :pending="withdraw.isPending.value"
        destructive
        @confirm="withdraw.mutate()"
      />

      <USlideover :open="!!editing" :title="editing ? t('guest.place', { n: editing.slotNo }) : ''" @update:open="value => { if (!value) editing = null }">
        <template #body>
          <UForm :state="details" :validate="validateDetails" class="flex flex-col gap-4" @submit="saveDetails.mutate()">
            <GuestFields v-model="details" />
            <UAlert v-if="saveDetails.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(saveDetails.error.value)" role="alert" />
            <UButton type="submit" :loading="saveDetails.isPending.value" class="self-start">{{ t('common.save') }}</UButton>
          </UForm>
        </template>
      </USlideover>
    </template>
  </div>
</template>
