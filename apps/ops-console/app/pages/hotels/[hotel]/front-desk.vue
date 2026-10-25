<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { checkInLookupSchema } from '@hajj/contracts/schemas/booking'
import type { CheckInLookupDto } from '@hajj/contracts/types/frontDesk'
import { addDays } from '@hajj/contracts/utils/dates'
import { arrivalsOf, bookerName, departuresOf } from '../../../utils/occupancy'

/**
 * The front desk (v7 §12, §17; `booking.checkIn`): open a booking from its receipt — the QR code typed in by a
 * handheld scanner, read by the camera, or the booking number — then check its pilgrims in on its page. Today's
 * arrivals and departures (with `occupancy.view`), with how many pilgrims still lack their details.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const access = useAccess()
const errorMessage = useErrorMessage()
const { hotel, hotelId, ready } = useCurrentHotel()
const allowed = computed(() => ready.value && access.value.canInHotel('booking.checkIn', hotelId.value))
const seesDay = computed(() => ready.value && access.value.canInHotel('occupancy.view', hotelId.value))
const canScan = computed(() => import.meta.client && 'BarcodeDetector' in globalThis)

const code = ref({ receiptToken: '' })
/** A receipt code is what its QR holds: anything else is said at once, in words the desk understands. */
const validate = (state: typeof code.value) => (checkInLookupSchema.safeParse({ receiptToken: state.receiptToken.trim() }).success ? [] : [{ name: 'receiptToken', message: t('desk.notAReceipt') }])
const lookup = useMutation({
  mutationFn: (receiptToken: string) => api<CheckInLookupDto>('/check-in/lookup', { method: 'POST', body: { receiptToken } }),
  onSuccess: async (found) => {
    code.value = { receiptToken: '' }
    // A cancelled or ended booking still opens: its page says what it is, and offers nothing to do.
    await navigateTo(`/bookings/${found.bookingId}`)
  },
})
const lookUp = (receiptToken: string) => lookup.mutate(receiptToken.trim())
const scanning = ref(false)
const number = ref('')
const findNumber = () => navigateTo({ path: '/bookings', query: { hotel: hotel.value?.code, q: number.value.trim() || undefined } })

const today = computed(() => hotel.value?.today ?? '')
const tonight = useOccupancyDay(hotelId, today, seesDay)
const lastNight = useOccupancyDay(hotelId, () => (today.value ? addDays(today.value, -1) : ''), seesDay)
const whoBooked = (item: { booker: { agencyId: string | null, name: string | null } }) => bookerName(item.booker, { individual: t('bookings.individual'), agency: t('bookings.agency') })
const arrivals = computed(() => (tonight.data.value ? arrivalsOf(tonight.data.value) : []))
const departures = computed(() => (lastNight.data.value ? departuresOf(lastNight.data.value, today.value) : []))
const lists = computed(() => [
  { key: 'arrivals', title: t('desk.arrivalsToday'), none: t('desk.noArrivals'), query: tonight, items: arrivals.value },
  { key: 'departures', title: t('desk.departuresToday'), none: t('desk.noDepartures'), query: lastNight, items: departures.value },
])
</script>

<template>
  <HotelFrame :title="t('nav.frontDesk')">
    <EmptyState v-if="ready && !allowed" :title="t('errors.forbidden')" icon="i-lucide-lock" />
    <template v-else>
      <div class="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="receipt-heading" class="surface-panel flex flex-col gap-3 p-5">
          <h2 id="receipt-heading" class="text-section">{{ t('desk.receipt') }}</h2>
          <p class="text-small text-(--fg-muted)">{{ t('desk.receiptHelp') }}</p>
          <UForm :state="code" :validate="validate" class="flex flex-wrap items-start gap-2" @submit="lookUp(code.receiptToken)">
            <UFormField name="receiptToken" class="min-w-60 flex-1">
              <UInput v-model="code.receiptToken" icon="i-lucide-qr-code" :placeholder="t('desk.receiptPlaceholder')" :aria-label="t('desk.receipt')" autocomplete="off" autofocus dir="ltr" class="w-full" />
            </UFormField>
            <UButton type="submit" :loading="lookup.isPending.value">{{ t('desk.open') }}</UButton>
            <UButton v-if="canScan" color="neutral" variant="outline" icon="i-lucide-camera" @click="scanning = true">{{ t('desk.scan') }}</UButton>
          </UForm>
          <UAlert v-if="lookup.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(lookup.error.value)" role="alert" />
        </section>
        <section aria-labelledby="number-heading" class="surface-panel flex flex-col gap-3 p-5">
          <h2 id="number-heading" class="text-section">{{ t('desk.byNumber') }}</h2>
          <form class="flex flex-wrap gap-2" @submit.prevent="findNumber">
            <UInput v-model="number" icon="i-lucide-search" :placeholder="t('bookings.search')" :aria-label="t('bookings.search')" dir="ltr" class="min-w-60 flex-1" />
            <UButton type="submit" color="neutral" variant="outline">{{ t('desk.find') }}</UButton>
          </form>
        </section>
      </div>

      <section v-for="list in (seesDay ? lists : [])" :key="list.key" :aria-labelledby="`${list.key}-heading`" class="flex flex-col gap-3">
        <h2 :id="`${list.key}-heading`" class="text-section">{{ list.title }}</h2>
        <ErrorState v-if="list.query.error.value" :error="list.query.error.value" @retry="list.query.refetch()" />
        <USkeleton v-else-if="list.query.isPending.value" class="h-24" />
        <p v-else-if="!list.items.length" class="text-(--fg-muted)">{{ list.none }}</p>
        <ul v-else class="surface-panel divide-y divide-(--border)">
          <li v-for="item in list.items" :key="item.bookingId" class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
            <NuxtLink :to="`/bookings/${item.bookingId}`" class="font-semibold tabular hover:underline" dir="ltr">{{ item.bookingNo }}</NuxtLink>
            <bdi>{{ whoBooked(item) }}</bdi>
            <span class="text-small">{{ t('desk.pilgrims', { count: item.pilgrims }, item.pilgrims) }} · {{ t('desk.rooms', { rooms: item.rooms.join(t('calendar.separator')) }) }}</span>
            <span v-if="item.detailsPending" class="text-small text-(--warning)">{{ t('desk.detailsMissing', { count: item.detailsPending }, item.detailsPending) }}</span>
            <UButton :to="`/bookings/${item.bookingId}`" size="sm" color="neutral" variant="outline" class="ms-auto">{{ t('occupancy.openBooking') }}</UButton>
          </li>
        </ul>
      </section>
      <ReceiptScanner v-model:open="scanning" @found="lookUp" />
    </template>
  </HotelFrame>
</template>
