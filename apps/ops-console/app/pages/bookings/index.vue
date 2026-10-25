<script setup lang="ts">
import { keepPreviousData } from '@tanstack/vue-query'
import { BOOKING_STATUSES, type BookingStatus } from '@hajj/contracts/constants/booking'
import type { BookingDto, BookingPage } from '@hajj/contracts/types/booking'

/**
 * Bookings (§36, v7 §7): of the hotels this user can see, or of the hotel chosen in the switcher (`?hotel=`), newest
 * first — number, hotel, who booked, the stay, the pilgrims, the status and the price. Filters live in the URL; the
 * number search waits for a pause. A new booking is made on an agency's behalf (`booking.create`, `agency.view`).
 */
definePageMeta({ middleware: 'auth', scope: 'portfolio' })
const { t } = useI18n()
const api = useApi()
const access = useAccess()
const { queryOf, setQuery, searchOf, pageOf } = useUrlQuery()
const { hotels, current } = useHotelScope()
useSeoMeta({ title: () => t('nav.bookings') })
const PAGE_SIZE = 25
const ALL = 'ALL'

const isStatus = (value: string | undefined): value is BookingStatus => !!value && (BOOKING_STATUSES as readonly string[]).includes(value)
const status = computed({ get: () => (isStatus(queryOf('status')) ? queryOf('status')! : ALL), set: (value: string) => setQuery({ status: value === ALL ? undefined : value, page: undefined }) })
const seesAgencies = computed(() => access.value.can('agency.view'))
const agencies = useAgencies(seesAgencies)
const agency = computed({ get: () => queryOf('agency') ?? ALL, set: (value: string) => setQuery({ agency: value === ALL ? undefined : value, page: undefined }) })
const search = searchOf('q', { page: undefined })
const q = computed(() => queryOf('q') ?? '')
const page = pageOf()

const bookings = useApiQuery(
  () => ['bookings', current.value?.id ?? ALL, status.value, agency.value, q.value, page.value],
  () => api<BookingPage>('/bookings', {
    query: { hotelId: current.value?.id, status: status.value === ALL ? undefined : status.value, agencyId: agency.value === ALL ? undefined : agency.value, q: q.value || undefined, page: page.value, pageSize: PAGE_SIZE },
  }),
  { enabled: computed(() => !!hotels.data.value), placeholderData: keepPreviousData },
)
const filtered = computed(() => status.value !== ALL || agency.value !== ALL || !!q.value)
const clearFilters = () => setQuery({ status: undefined, agency: undefined, q: undefined, page: undefined })
const statusItems = computed(() => [{ value: ALL, label: t('bookings.allStatuses') }, ...BOOKING_STATUSES.map(value => ({ value, label: t(`status.booking.${value}`) }))])
const agencyItems = computed(() => [{ value: ALL, label: t('bookings.allAgencies') }, ...agencies.items.value])
const showHotel = computed(() => !current.value && hotels.items.value.length > 1)
const canBook = computed(() => access.value.can('booking.create') && seesAgencies.value)
const linkOf = (booking: BookingDto) => `/bookings/${booking.id}`
const newLink = computed(() => (current.value ? `/bookings/new?hotel=${encodeURIComponent(current.value.code)}` : '/bookings/new'))
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="t('bookings.title')" :description="current?.name">
      <template #actions>
        <UButton v-if="canBook" :to="newLink" icon="i-lucide-plus">{{ t('bookings.new') }}</UButton>
      </template>
    </PageHeader>
    <div class="flex flex-wrap gap-2">
      <UInput v-model="search" icon="i-lucide-search" :placeholder="t('bookings.search')" :aria-label="t('bookings.search')" dir="ltr" class="w-48" />
      <USelect v-model="status" :items="statusItems" :aria-label="t('bookings.statusLabel')" class="w-44" />
      <USelect v-if="seesAgencies" v-model="agency" :items="agencyItems" :aria-label="t('bookings.agency')" class="w-56" />
      <UButton v-if="filtered" color="neutral" variant="ghost" @click="clearFilters">{{ t('common.clearFilters') }}</UButton>
    </div>

    <ErrorState v-if="bookings.error.value" :error="bookings.error.value" @retry="bookings.refetch()" />
    <div v-else-if="bookings.isPending.value" class="flex flex-col gap-2"><USkeleton v-for="n in 8" :key="n" class="h-12" /></div>
    <EmptyState v-else-if="!bookings.data.value?.items.length" :title="filtered ? t('bookings.noMatch') : t('bookings.none')" icon="i-lucide-notebook-tabs">
      <UButton v-if="filtered" color="neutral" variant="outline" @click="clearFilters">{{ t('common.clearFilters') }}</UButton>
    </EmptyState>
    <div v-else class="surface-panel overflow-x-auto" :class="{ 'opacity-60': bookings.isPlaceholderData.value }">
      <table class="w-full">
        <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
          <tr>
            <th scope="col" class="px-4 py-2 text-start">{{ t('bookings.column') }}</th>
            <th v-if="showHotel" scope="col" class="px-4 py-2 text-start">{{ t('bookings.hotel') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('bookings.bookedBy') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('bookings.stay') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('bookings.pilgrims') }}</th>
            <th scope="col" class="px-4 py-2 text-start">{{ t('bookings.status') }}</th>
            <th scope="col" class="px-4 py-2 text-end">{{ t('bookings.price') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--border)">
          <tr v-for="booking in bookings.data.value.items" :key="booking.id">
            <td class="px-4 py-2 font-semibold tabular"><NuxtLink :to="linkOf(booking)" class="hover:underline" dir="ltr">{{ booking.bookingNo }}</NuxtLink></td>
            <td v-if="showHotel" class="px-4 py-2">
              <span v-if="hotels.byId(booking.hotelId)" class="flex items-center gap-2"><HotelMarker :hotel="hotels.byId(booking.hotelId)!" size="sm" /><bdi class="truncate">{{ hotels.byId(booking.hotelId)!.name }}</bdi></span>
            </td>
            <td class="px-4 py-2">
              <bdi>{{ booking.agencyName ?? (booking.agencyId ? t('bookings.agency') : t('bookings.individual')) }}</bdi>
              <span class="block text-caption text-(--fg-muted)">{{ t(`booking.type.${booking.bookingType}`) }}</span>
            </td>
            <td class="px-4 py-2 whitespace-nowrap"><StayDates :check-in="booking.checkIn" :check-out="booking.checkOut" /></td>
            <td class="px-4 py-2 text-end tabular">
              {{ booking.totalCount }}
              <span v-if="booking.infantCount" class="block text-caption text-(--fg-muted)">{{ t('bookings.infants', { count: booking.infantCount }, booking.infantCount) }}</span>
            </td>
            <td class="px-4 py-2"><StatusBadge domain="booking" :value="booking.status" /></td>
            <td class="px-4 py-2 text-end"><MoneyText :halalas="booking.totalHalalas" /></td>
          </tr>
        </tbody>
      </table>
    </div>
    <UPagination v-if="(bookings.data.value?.total ?? 0) > PAGE_SIZE" v-model:page="page" :total="bookings.data.value!.total" :items-per-page="PAGE_SIZE" class="self-center" />
  </div>
</template>
