<script setup lang="ts">
import type { BookingPage } from '@hajj/contracts/types/booking'

definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const page = ref(1)
const PAGE_SIZE = 20
useSeoMeta({ title: () => t('bookings.title'), robots: 'noindex' })
const { data, error, isPending, refetch } = useApiQuery(() => ['customer-bookings', page.value], () => api<BookingPage>('/customer/bookings', { query: { page: page.value, pageSize: PAGE_SIZE } }))
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="t('bookings.title')">
      <template #actions>
        <UButton to="/book" icon="i-lucide-plus">{{ t('site.nav.book') }}</UButton>
      </template>
    </PageHeader>
    <ErrorState v-if="error" :error="error" @retry="refetch()" />
    <div v-else-if="isPending" class="flex flex-col gap-3">
      <USkeleton v-for="n in 3" :key="n" class="h-20" />
    </div>
    <EmptyState v-else-if="!data?.items.length" :title="t('bookings.none')" icon="i-lucide-calendar">
      <UButton to="/book">{{ t('site.nav.book') }}</UButton>
    </EmptyState>
    <template v-else>
      <ul class="flex flex-col gap-3">
        <li v-for="booking in data.items" :key="booking.id">
          <NuxtLink :to="`/bookings/${booking.id}`" class="surface-panel flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-(--surface-2)">
            <div class="flex flex-col gap-1">
              <span class="text-subsection tabular" dir="ltr">{{ booking.bookingNo }}</span>
              <StayDates :check-in="booking.checkIn" :check-out="booking.checkOut" class="text-(--fg-muted)" />
            </div>
            <div class="flex items-center gap-3">
              <MoneyText :halalas="booking.totalHalalas" />
              <StatusBadge domain="booking" :value="booking.status" />
            </div>
          </NuxtLink>
        </li>
      </ul>
      <UPagination v-if="data.total > PAGE_SIZE" v-model:page="page" :total="data.total" :items-per-page="PAGE_SIZE" class="self-center" />
    </template>
  </div>
</template>
