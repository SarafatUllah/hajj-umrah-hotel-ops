<script setup lang="ts">
import type { QuoteDto } from '@hajj/contracts/types/quote'

definePageMeta({ middleware: ['auth', 'approved'] })
const { t } = useI18n()
const route = useRoute()
const api = useApi()
const format = useFormat()
const hotels = usePublicHotels()
const id = computed(() => String(route.params.id))
const { data: quote, error, isPending, refetch } = useApiQuery(() => ['agency-quote', id.value], () => api<QuoteDto>(`/agency/quotes/${id.value}`))
useSeoMeta({ title: () => quote.value?.refNo ?? t('quotes.title') })
</script>

<template>
  <div class="flex flex-col gap-6">
    <ErrorState v-if="error" :error="error" @retry="refetch()" />
    <USkeleton v-else-if="isPending" class="h-40" />
    <template v-else-if="quote">
      <PageHeader :title="quote.refNo" :description="hotels.nameOf(quote.hotelId)">
        <template #actions>
          <StatusBadge domain="quote" :value="quote.status" />
          <UButton v-if="quote.status === 'OFFERED'" :to="{ path: '/book', query: { quote: quote.id } }" icon="i-lucide-calendar-plus">{{ t('quotes.book') }}</UButton>
        </template>
      </PageHeader>
      <dl class="surface-panel grid gap-4 p-5 sm:grid-cols-4">
        <div><dt class="text-caption text-(--fg-muted)">{{ t('bookings.stay') }}</dt><dd><StayDates :check-in="quote.checkIn" :check-out="quote.checkOut" /></dd></div>
        <div><dt class="text-caption text-(--fg-muted)">{{ t('quotes.pilgrims') }}</dt><dd>{{ t(`booking.type.${quote.bookingType}`) }} · {{ $t('common.pilgrims', quote.totalCount) }}</dd></div>
        <div><dt class="text-caption text-(--fg-muted)">{{ t('quotes.amount') }}</dt><dd><template v-if="quote.amountHalalas !== null"><MoneyText :halalas="quote.amountHalalas" /> {{ quote.unit ? t(`booking.priceUnit.${quote.unit}`) : '' }}</template><template v-else>—</template></dd></div>
        <div><dt class="text-caption text-(--fg-muted)">{{ t('quotes.validUntil') }}</dt><dd>{{ quote.validUntil ? format.dateTime(quote.validUntil) : '—' }}</dd></div>
      </dl>
      <p v-if="quote.notes" class="max-w-prose text-(--fg-muted)"><bdi>{{ quote.notes }}</bdi></p>
    </template>
  </div>
</template>
