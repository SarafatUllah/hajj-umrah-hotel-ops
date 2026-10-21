<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { CONFIRMED_BOOKING_STATUSES, SEAT_HOLDING_STATUSES } from '@hajj/contracts/constants/booking'
import type { BookingDetailDto, GuestSlotDto, ReceiptDto } from '@hajj/contracts/types/booking'

definePageMeta({ middleware: ['auth', 'approved'] })
const { t } = useI18n()
const route = useRoute()
const api = useApi()
const notify = useNotify()
const queryClient = useQueryClient()
const hotels = usePublicHotels()
const id = computed(() => String(route.params.id))
/** The booking's path in the API, as the shared pilgrim panels reach it. */
const base = computed(() => `/agency/bookings/${id.value}`)

const booking = useApiQuery(() => ['agency-booking', id.value], () => api<BookingDetailDto>(`/agency/bookings/${id.value}`))
const guests = useApiQuery(() => ['agency-guests', id.value], () => api<GuestSlotDto[]>(`/agency/bookings/${id.value}/guests`))
const status = computed(() => booking.data.value?.status ?? '')
const isIn = (statuses: readonly string[]) => statuses.includes(status.value)
const confirmedStatus = computed(() => isIn(CONFIRMED_BOOKING_STATUSES))
const receipt = useApiQuery(() => ['agency-receipt', id.value], () => api<ReceiptDto>(`/agency/bookings/${id.value}/receipt`), { enabled: confirmedStatus })
/** Pilgrims' details and passport photos change while the booking still holds its places (the API's rule). */
const openForDetails = computed(() => isIn(SEAT_HOLDING_STATUSES))
// The browser saw the hold run out: nothing more to confirm, whatever the server says until it expires it.
const holdEnded = ref(false)
const canAdd = computed(() => status.value === 'CONFIRMED' || (status.value === 'HELD' && !holdEnded.value))
watch(id, () => { holdEnded.value = false })
function onHoldEnded(): void {
  holdEnded.value = true
  void booking.refetch()
}
useSeoMeta({ title: () => (booking.data.value ? t('bookings.number', { no: booking.data.value.bookingNo }) : t('bookings.title')) })

const refresh = () => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['agency-booking', id.value] }),
  queryClient.invalidateQueries({ queryKey: ['agency-guests', id.value] }),
  queryClient.invalidateQueries({ queryKey: ['agency-bookings'] }),
])

const confirm = useMutation({
  mutationFn: () => api<BookingDetailDto>(`/agency/bookings/${id.value}/confirm`, { method: 'POST' }),
  onSuccess: async () => {
    notify.done(t('bookings.confirmed'))
    await refresh()
  },
  onError: error => notify.failed(error),
})
const releaseOpen = ref(false)
const release = useMutation({
  mutationFn: () => api<BookingDetailDto>(`/agency/bookings/${id.value}/release`, { method: 'POST' }),
  onSuccess: async () => {
    releaseOpen.value = false
    notify.done(t('bookings.released'))
    await refresh()
  },
  onError: (error) => {
    releaseOpen.value = false
    notify.failed(error)
  },
})
const printReceipt = () => window.print()
</script>

<template>
  <div class="flex flex-col gap-6">
    <ErrorState v-if="booking.error.value" :error="booking.error.value" @retry="booking.refetch()" />
    <USkeleton v-else-if="booking.isPending.value" class="h-48" />
    <template v-else-if="booking.data.value">
      <PageHeader :title="t('bookings.number', { no: booking.data.value.bookingNo })" :description="hotels.nameOf(booking.data.value.hotelId)">
        <template #actions>
          <StatusBadge domain="booking" :value="status" />
          <template v-if="status === 'HELD' && !holdEnded">
            <UButton icon="i-lucide-circle-check" :loading="confirm.isPending.value" @click="confirm.mutate()">{{ t('bookings.confirm') }}</UButton>
            <UButton color="neutral" variant="outline" icon="i-lucide-undo-2" @click="releaseOpen = true">{{ t('bookings.release') }}</UButton>
          </template>
        </template>
      </PageHeader>

      <HoldCountdown v-if="status === 'HELD' && booking.data.value.holdExpiresAt" :until="booking.data.value.holdExpiresAt" @ended="onHoldEnded" />
      <p v-if="confirmedStatus" class="text-small text-(--fg-muted)">{{ t('bookings.askHotel') }}</p>

      <dl class="surface-panel grid gap-4 p-5 sm:grid-cols-4">
        <div>
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.stay') }}</dt>
          <dd><StayDates :check-in="booking.data.value.checkIn" :check-out="booking.data.value.checkOut" /></dd>
        </div>
        <div>
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.pilgrims') }}</dt>
          <dd class="tabular">{{ booking.data.value.totalCount }}<template v-if="booking.data.value.infantCount"> + {{ booking.data.value.infantCount }} {{ t('booking.ageGroup.INFANT') }}</template></dd>
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

      <section v-if="receipt.data.value" aria-labelledby="receipt-heading" class="surface-panel flex flex-col items-center gap-4 p-6">
        <h2 id="receipt-heading" class="text-section self-start">{{ t('receipt.title') }}</h2>
        <ReceiptQr :token="receipt.data.value.qrToken" :booking-no="receipt.data.value.bookingNo" />
        <UButton color="neutral" variant="outline" icon="i-lucide-printer" class="print:hidden" @click="printReceipt">{{ t('receipt.print') }}</UButton>
      </section>

      <section aria-labelledby="pilgrims-heading" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="pilgrims-heading" class="text-section">{{ t('bookings.pilgrims') }}</h2>
          <span class="text-(--fg-muted)">{{ t('bookings.detailsProgress', { done: booking.data.value.guests.withDetails, total: booking.data.value.guests.total }) }}</span>
        </div>
        <ErrorState v-if="guests.error.value" :error="guests.error.value" @retry="guests.refetch()" />
        <PilgrimsPanel v-else-if="guests.data.value" :base="base" :guests="guests.data.value" :editable="openForDetails" @changed="refresh" />
        <USkeleton v-else class="h-40" />
      </section>

      <section v-if="guests.data.value && openForDetails" aria-labelledby="scans-heading" class="flex flex-col gap-3">
        <h2 id="scans-heading" class="text-section">{{ t('scans.title') }}</h2>
        <PassportScans :base="base" :guests="guests.data.value" @changed="refresh" />
      </section>

      <section v-if="canAdd" aria-labelledby="add-heading" class="flex flex-col gap-3">
        <h2 id="add-heading" class="text-section">{{ t('additions.title') }}</h2>
        <AddPilgrims :base="base" :booking-type="booking.data.value.bookingType" @added="refresh" />
      </section>

      <ConfirmDialog
        v-model:open="releaseOpen"
        :title="t('bookings.releaseTitle')"
        :description="t('bookings.releaseText', { no: booking.data.value.bookingNo })"
        :confirm-label="t('bookings.release')"
        :pending="release.isPending.value"
        destructive
        @confirm="release.mutate()"
      />
    </template>
  </div>
</template>
