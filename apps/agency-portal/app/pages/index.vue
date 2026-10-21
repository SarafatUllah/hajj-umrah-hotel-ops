<script setup lang="ts">
import { keepPreviousData } from '@tanstack/vue-query'
import { BOOKING_STATUSES } from '@hajj/contracts/constants/booking'
import type { BookingPage } from '@hajj/contracts/types/booking'

definePageMeta({ middleware: ['auth', 'approved'] })
const { t } = useI18n()
const api = useApi()
const hotels = useHotels()
const PAGE_SIZE = 20
const page = ref(1)
const status = ref<string>('ALL')
watch(status, () => { page.value = 1 })
const statusItems = computed(() => [{ value: 'ALL', label: t('bookings.allStatuses') }, ...BOOKING_STATUSES.map(value => ({ value, label: t(`status.booking.${value}`) }))])
useSeoMeta({ title: () => t('bookings.title') })
// Another page or filter keeps the rows shown (dimmed) until it arrives.
const { data, error, isPending, isPlaceholderData, refetch } = useApiQuery(() => ['agency-bookings', status.value, page.value], () => api<BookingPage>('/agency/bookings', {
  query: { page: page.value, pageSize: PAGE_SIZE, status: status.value === 'ALL' ? undefined : status.value },
}), { placeholderData: keepPreviousData })
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="t('bookings.title')">
      <template #actions>
        <UButton to="/book" icon="i-lucide-plus">{{ t('portal.nav.book') }}</UButton>
      </template>
    </PageHeader>
    <div class="flex flex-wrap gap-2">
      <USelect v-model="status" :items="statusItems" class="w-56" :aria-label="t('bookings.status')" />
    </div>
    <ErrorState v-if="error" :error="error" @retry="refetch()" />
    <div v-else-if="isPending" class="flex flex-col gap-3">
      <USkeleton v-for="n in 4" :key="n" class="h-16" />
    </div>
    <EmptyState v-else-if="!data?.items.length" :title="t('bookings.none')" icon="i-lucide-calendar">
      <UButton to="/book">{{ t('portal.nav.book') }}</UButton>
    </EmptyState>
    <template v-else>
      <div class="surface-panel overflow-x-auto" :class="{ 'opacity-60': isPlaceholderData }" :aria-busy="isPlaceholderData">
        <table class="w-full text-start">
          <thead class="bg-(--surface-2) text-caption text-(--fg-muted)">
            <tr>
              <th scope="col" class="px-4 py-2 text-start">{{ t('bookings.column') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('stay.hotel') }}</th>
              <th scope="col" class="px-4 py-2 text-start">{{ t('bookings.stay') }}</th>
              <th scope="col" class="px-4 py-2 text-end">{{ t('bookings.pilgrims') }}</th>
              <th scope="col" class="px-4 py-2 text-end">{{ t('bookings.price') }}</th>
              <th scope="col" class="px-4 py-2 text-start"><span class="sr-only">{{ t('bookings.status') }}</span></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-(--border)">
            <tr v-for="booking in data.items" :key="booking.id" class="hover:bg-(--surface-2)">
              <td class="px-4 py-3"><NuxtLink :to="`/bookings/${booking.id}`" class="tabular font-medium text-(--primary)" dir="ltr">{{ booking.bookingNo }}</NuxtLink></td>
              <td class="px-4 py-3"><bdi>{{ hotels.nameOf(booking.hotelId) }}</bdi></td>
              <td class="px-4 py-3"><StayDates :check-in="booking.checkIn" :check-out="booking.checkOut" /></td>
              <td class="px-4 py-3 text-end tabular">{{ booking.totalCount }}</td>
              <td class="px-4 py-3 text-end"><MoneyText :halalas="booking.totalHalalas" /></td>
              <td class="px-4 py-3"><StatusBadge domain="booking" :value="booking.status" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <UPagination v-if="data.total > PAGE_SIZE" v-model:page="page" :total="data.total" :items-per-page="PAGE_SIZE" class="self-center" />
    </template>
  </div>
</template>
