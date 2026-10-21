<script setup lang="ts">
import { keepPreviousData, useMutation, useQueryClient } from '@tanstack/vue-query'
import type { Permission } from '@hajj/contracts/constants/permissions'
import type { BookingDetailDto, GuestSlotDto, ReceiptDto } from '@hajj/contracts/types/booking'
import type { GuestMoveDto } from '@hajj/contracts/types/frontDesk'
import { bookingActionsOf, guestActionsOf } from '../../utils/booking'

/**
 * One booking (§36, v7 §7, §12): who booked, the stay, the pilgrims (how many have their details, how many arrived),
 * the rooms and the price. Confirm a hold or a request, cancel, change the dates, add pilgrims, read their passport
 * photos; at the desk, check each pilgrim in and out, mark one as not come, remove or move one. What is offered follows
 * the status, the hotel's date and the user's permissions — the API decides, and says why when it refuses. An inactive
 * hotel takes no change but a cancellation. Passport numbers in full, and the passport photos, only with
 * `pilgrim.viewSensitive` — every read is logged and counted, so neither is asked again unless needed.
 */
definePageMeta({ middleware: 'auth' })
type DeskMove = 'check-in' | 'check-out' | 'no-show'
type Confirming = { kind: 'check-out' | 'no-show' | 'remove', guest: GuestSlotDto }

const { t } = useI18n()
const route = useRoute()
const api = useApi()
const format = useFormat()
const notify = useNotify()
const access = useAccess()
const queryClient = useQueryClient()
const hotels = useHotels()
const id = computed(() => String(route.params.id))
const base = computed(() => `/bookings/${id.value}`)

const booking = useApiQuery(() => ['booking', id.value], () => api<BookingDetailDto>(base.value))
const hotel = computed(() => hotels.byId(booking.data.value?.hotelId))
const notFound = computed(() => !!booking.error.value && toApiError(booking.error.value).status === 404)
useSeoMeta({ title: () => (booking.data.value ? t('bookings.number', { no: booking.data.value.bookingNo }) : t('nav.bookings')) })

const inHotel = (permission: Permission) => !!hotel.value && access.value.canInHotel(permission, hotel.value.id)
const hotelActive = computed(() => hotel.value?.status === 'ACTIVE')
const seesPilgrims = computed(() => inHotel('pilgrim.view'))
const canReveal = computed(() => inHotel('pilgrim.viewSensitive'))
const reveal = ref(false)
const guests = useApiQuery(
  () => ['booking-guests', id.value, reveal.value],
  () => api<GuestSlotDto[]>(`${base.value}/guests`, { query: { reveal: reveal.value ? 'passport' : undefined } }),
  { enabled: seesPilgrims, placeholderData: keepPreviousData },
)
// Numbers shown in full are not kept once hidden (showing them again is a new, logged read), nor for another booking.
watch(reveal, (shown) => { if (!shown) queryClient.removeQueries({ queryKey: ['booking-guests', id.value, true] }) })
watch(id, () => { reveal.value = false })
const actions = computed(() => (booking.data.value && hotel.value ? bookingActionsOf(booking.data.value, guests.data.value ?? null, inHotel, hotelActive.value) : null))
const receipt = useApiQuery(() => ['booking-receipt', id.value], () => api<ReceiptDto>(`${base.value}/receipt`), { enabled: computed(() => !!actions.value?.receipt) })
const deskOf = (guest: GuestSlotDto) => guestActionsOf(guest, { ...booking.data.value!, pilgrims: booking.data.value!.guests.total }, hotel.value!.today, inHotel, hotelActive.value)

// The passport photos refresh themselves (their reading is logged): a change elsewhere on the page leaves them be.
const refreshBooking = useBookingRefresh()
const refresh = () => refreshBooking(id.value)
async function changed(message: string): Promise<void> {
  notify.done(message)
  await refresh()
}

// The booking's own actions.
const confirm = useMutation({
  mutationFn: () => api<BookingDetailDto>(`${base.value}/confirm`, { method: 'POST' }),
  onSuccess: done => changed(t('bookings.confirmed', { no: done.bookingNo })),
  onError: notify.failed,
})
const holdEnded = ref(false)
watch(id, () => { holdEnded.value = false })
function onHoldEnded(): void {
  holdEnded.value = true
  void booking.refetch()
}
const cancelling = ref(false)
const changingDates = ref(false)

// The desk, pilgrim by pilgrim: check-in at once; leaving, not coming and removal asked first.
const nameOf = (guest: GuestSlotDto) => guest.details?.fullName ?? t('guest.place', { n: guest.slotNo })
const DESK_DONE: Record<DeskMove, string> = { 'check-in': 'desk.checkedIn', 'check-out': 'desk.checkedOut', 'no-show': 'desk.noShown' }
const desk = useMutation({
  mutationFn: ({ guest, move }: { guest: GuestSlotDto, move: DeskMove }) => api<GuestMoveDto>(`${base.value}/guests/${guest.id}/${move}`, { method: 'POST' }),
  onSuccess: async (_moved, { guest, move }) => {
    confirming.value = null
    await changed(t(DESK_DONE[move], { name: nameOf(guest) }))
  },
  onError: notify.failed,
})
const remove = useMutation({
  mutationFn: (guest: GuestSlotDto) => api<BookingDetailDto>(`${base.value}/guests/${guest.id}`, { method: 'DELETE' }),
  onSuccess: async (_done, guest) => {
    confirming.value = null
    await changed(t('pilgrims.removed', { name: nameOf(guest) }))
  },
  onError: notify.failed,
})
const confirming = ref<Confirming | null>(null)
/** The dialog's words: kept while it closes (its last question), so it does not empty itself mid-animation. */
const lastAsked = useLastShown(() => confirming.value)
const confirmText = computed(() => {
  const asked = lastAsked.value
  if (!asked || !booking.data.value) return null
  const name = nameOf(asked.guest)
  if (asked.kind === 'remove') return { title: t('pilgrims.removeTitle', { name }), description: t('pilgrims.removeText'), label: t('pilgrims.remove'), tier: 2 as const }
  if (asked.kind === 'no-show') return { title: t('desk.noShowTitle', { name }), description: t('desk.noShowText', { name }), label: t('desk.noShow'), tier: 2 as const }
  const leavesEarly = hotel.value!.today < booking.data.value.checkOut
  return {
    title: t('desk.checkOutTitle', { name }),
    description: leavesEarly ? t('desk.checkOutEarly', { name, date: format.date(booking.data.value.checkOut) }) : t('desk.checkOutText', { name }),
    label: t('desk.checkOut'),
    tier: 1 as const,
  }
})
function confirmAsked(): void {
  const asked = confirming.value
  if (!asked) return
  if (asked.kind === 'remove') remove.mutate(asked.guest)
  else desk.mutate({ guest: asked.guest, move: asked.kind })
}
const moving = ref<GuestSlotDto | null>(null)
async function moved(roomNumber: string): Promise<void> {
  moving.value = null
  await changed(t('pilgrims.moved', { room: roomNumber }))
}

const liveRooms = computed(() => booking.data.value?.rooms ?? [])
const printReceipt = () => window.print()
</script>

<template>
  <div class="flex flex-col gap-6">
    <UButton to="/bookings" color="neutral" variant="link" icon="i-lucide-arrow-left" :ui="{ leadingIcon: 'rtl:-scale-x-100' }" class="self-start print:hidden">{{ t('bookings.back') }}</UButton>
    <EmptyState v-if="notFound" :title="t('bookings.notFound')" icon="i-lucide-notebook-tabs" />
    <ErrorState v-else-if="booking.error.value" :error="booking.error.value" @retry="booking.refetch()" />
    <USkeleton v-else-if="!booking.data.value || !hotel || !actions" class="h-48" />
    <template v-else>
      <PageHeader :title="t('bookings.number', { no: booking.data.value.bookingNo })" :description="hotel.name">
        <template #actions>
          <StatusBadge domain="booking" :value="booking.data.value.status" />
          <UButton v-if="actions.confirm && !holdEnded" icon="i-lucide-circle-check" :loading="confirm.isPending.value" @click="confirm.mutate()">{{ t('bookings.confirm') }}</UButton>
          <UButton v-if="actions.changeDates" color="neutral" variant="outline" icon="i-lucide-calendar-range" @click="changingDates = true">{{ t('bookings.changeDates') }}</UButton>
          <UButton v-if="actions.cancel" color="error" variant="ghost" icon="i-lucide-x" @click="cancelling = true">{{ t('bookings.cancel') }}</UButton>
        </template>
      </PageHeader>

      <UAlert v-if="hotel.status === 'INACTIVE'" color="neutral" variant="soft" icon="i-lucide-circle-pause" :title="t('hotel.inactiveBanner')" />
      <HoldCountdown v-if="actions.confirm && booking.data.value.holdExpiresAt" :until="booking.data.value.holdExpiresAt" @ended="onHoldEnded" />
      <UAlert v-if="booking.data.value.status === 'REQUESTED'" color="info" variant="soft" icon="i-lucide-user" :title="t('bookings.requestNote')" />

      <dl class="surface-panel grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.bookedBy') }}</dt>
          <dd><bdi>{{ booking.data.value.agencyName ?? (booking.data.value.agencyId ? t('bookings.agency') : t('bookings.individual')) }}</bdi> · {{ t(`booking.type.${booking.data.value.bookingType}`) }}</dd>
        </div>
        <div>
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.stay') }}</dt>
          <dd><StayDates :check-in="booking.data.value.checkIn" :check-out="booking.data.value.checkOut" /></dd>
        </div>
        <div>
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.pilgrims') }}</dt>
          <dd class="tabular">
            {{ booking.data.value.totalCount }}
            <span v-if="booking.data.value.infantCount" class="text-(--fg-muted)">{{ t('bookings.infants', { count: booking.data.value.infantCount }, booking.data.value.infantCount) }}</span>
            <span v-if="booking.data.value.bookingType === 'GROUP'" class="block text-small text-(--fg-muted)">{{ t('stay.men') }} {{ booking.data.value.maleCount }} · {{ t('stay.women') }} {{ booking.data.value.femaleCount }} · {{ t('stay.children') }} {{ booking.data.value.childCount }}</span>
          </dd>
        </div>
        <div>
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.price') }}</dt>
          <dd><MoneyText :halalas="booking.data.value.totalHalalas" /> · {{ t(`booking.priceSource.${booking.data.value.priceSource}`) }}</dd>
        </div>
        <div>
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.created') }}</dt>
          <dd class="tabular">{{ format.dateTime(booking.data.value.createdAt, hotel.timezone) }}</dd>
        </div>
        <div class="sm:col-span-3">
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.progress') }}</dt>
          <dd>
            {{ t('bookings.detailsProgress', { done: booking.data.value.guests.withDetails, total: booking.data.value.guests.total }) }} ·
            {{ t('bookings.checkedInProgress', { done: booking.data.value.guests.checkedIn, total: booking.data.value.guests.total }) }}
          </dd>
        </div>
        <div v-if="booking.data.value.notes" class="sm:col-span-2 lg:col-span-4">
          <dt class="text-caption text-(--fg-muted)">{{ t('bookings.notes') }}</dt>
          <dd><bdi>{{ booking.data.value.notes }}</bdi></dd>
        </div>
      </dl>

      <section aria-labelledby="rooms-heading" class="flex flex-col gap-3">
        <h2 id="rooms-heading" class="text-section">{{ t('bookings.rooms') }}</h2>
        <ul class="surface-panel divide-y divide-(--border)">
          <li v-for="line in liveRooms" :key="`${line.roomId}${line.checkIn}`" class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3" :class="{ 'text-(--fg-muted)': line.status === 'RELEASED' }">
            <span class="font-semibold">{{ t('stay.room', { number: line.roomNumber, floor: line.floorLevel }) }}</span>
            <span class="text-small">{{ t(`booking.occupancy.${line.occupancy}`) }}<template v-if="line.extraBeds"> · {{ t('stay.extraBeds', { count: line.extraBeds }, line.extraBeds) }}</template></span>
            <StayDates :check-in="line.checkIn" :check-out="line.checkOut" class="text-small" />
            <span v-if="line.status === 'RELEASED'" class="text-small">{{ t('bookings.released') }}</span>
          </li>
        </ul>
      </section>

      <section v-if="seesPilgrims" aria-labelledby="pilgrims-heading" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pilgrims-heading" class="text-section">{{ t('bookings.pilgrims') }}</h2>
          <USwitch v-if="canReveal" v-model="reveal" :label="t('pilgrims.reveal')" :description="t('pilgrims.revealHelp')" />
        </div>
        <ErrorState v-if="guests.error.value" :error="guests.error.value" @retry="guests.refetch()" />
        <USkeleton v-else-if="!guests.data.value" class="h-40" />
        <PilgrimsPanel v-else :base="base" :guests="guests.data.value" :editable="actions.editDetails" edits-arrived @changed="refresh">
          <template #actions="{ guest }">
            <PilgrimDeskActions
              :offer="deskOf(guest)"
              :name="nameOf(guest)"
              :checking-in="desk.isPending.value && desk.variables.value?.guest.id === guest.id"
              :busy="desk.isPending.value"
              @check-in="desk.mutate({ guest, move: 'check-in' })"
              @check-out="confirming = { kind: 'check-out', guest }"
              @move="moving = guest"
              @no-show="confirming = { kind: 'no-show', guest }"
              @remove="confirming = { kind: 'remove', guest }"
            />
          </template>
        </PilgrimsPanel>
      </section>

      <section v-if="canReveal && actions.scans && guests.data.value" aria-labelledby="scans-heading" class="flex flex-col gap-3">
        <h2 id="scans-heading" class="text-section">{{ t('scans.title') }}</h2>
        <PassportScans :base="base" :guests="guests.data.value" @changed="refresh" />
      </section>

      <section v-if="actions.addPilgrims" aria-labelledby="add-heading" class="flex flex-col gap-3">
        <h2 id="add-heading" class="text-section">{{ t('additions.title') }}</h2>
        <AddPilgrims :base="base" :booking-type="booking.data.value.bookingType" @added="refresh" />
      </section>

      <section v-if="receipt.data.value" aria-labelledby="receipt-heading" class="surface-panel flex flex-col items-center gap-4 p-6">
        <h2 id="receipt-heading" class="text-section self-start">{{ t('receipt.title') }}</h2>
        <ReceiptQr :token="receipt.data.value.qrToken" :booking-no="receipt.data.value.bookingNo" />
        <UButton color="neutral" variant="outline" icon="i-lucide-printer" class="print:hidden" @click="printReceipt">{{ t('receipt.print') }}</UButton>
      </section>

      <CancelBookingDialog v-model:open="cancelling" :booking="booking.data.value" @done="done => changed(t('bookings.cancelled', { no: done.bookingNo }))" />
      <DateChangeDrawer v-model:open="changingDates" :booking="booking.data.value" :hotel="hotel" @done="done => changed(t('bookings.datesChanged', { no: done.bookingNo }))" />
      <MoveGuestsDrawer :booking="booking.data.value" :hotel="hotel" :guests="guests.data.value ?? []" :guest="moving" @close="moving = null" @done="moved" />
      <ConfirmDialog
        v-if="confirmText"
        :open="!!confirming"
        :title="confirmText.title"
        :description="confirmText.description"
        :confirm-label="confirmText.label"
        :tier="confirmText.tier"
        :pending="desk.isPending.value || remove.isPending.value"
        destructive
        @update:open="value => { if (!value) confirming = null }"
        @confirm="confirmAsked"
      />
    </template>
  </div>
</template>
